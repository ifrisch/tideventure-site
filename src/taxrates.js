// Federal rate tables, by tax year and filing status.
//
// ── Read this before adding a year ──
// This is the only file in the project that asserts a tax-law figure. Everything
// else either takes a number from the CPA or does arithmetic on numbers it was
// given. So the rule here is: a year is either fully present and reviewed, or it
// is absent and the calculation REFUSES.
//
// It must never fall back to the nearest year it has. Applying 2025 brackets to
// 2027 income produces a plausible, confident, wrong answer — the exact failure
// the whole worksheet is built to avoid. `federalTax` returns { available:false }
// for a year that is not here, and the caller keeps the typed figure.
//
// Each year records where its figures came from and who checked them.
//   sourced   transcribed from the IRS Revenue Procedure named in `source`
//   reviewed  a CPA has checked them against their own copy
// Both matter and they are not the same thing. Transcription can still mis-key a
// digit, so `reviewed` stays false until a human with professional
// responsibility has actually looked.

export const TAX_YEARS = {
  2025: {
    sourced: true,
    reviewed: false,
    reviewedBy: null,
    reviewedOn: null,
    source: 'Rev. Proc. 2024-40, section 2.01 tables 1-4 (pages 5-6) and section 2.03 (page 7). https://www.irs.gov/pub/irs-drop/rp-24-40.pdf',
    // [upTo, rate] — the last band uses Infinity. Checked against the Revenue
    // Procedure's own "base amount plus rate on the excess" form; all 28 bands
    // and all 8 capital gain breakpoints reproduce exactly.
    //
    // Note: the OBBBA amended the 2025 STANDARD DEDUCTION (Rev. Proc. 2025-32
    // section 3.01) but left these rate tables untouched, so they still govern.
    ordinary: {
      single: [[11925,0.10],[48475,0.12],[103350,0.22],[197300,0.24],[250525,0.32],[626350,0.35],[Infinity,0.37]],
      mfj:    [[23850,0.10],[96950,0.12],[206700,0.22],[394600,0.24],[501050,0.32],[751600,0.35],[Infinity,0.37]],
      mfs:    [[11925,0.10],[48475,0.12],[103350,0.22],[197300,0.24],[250525,0.32],[375800,0.35],[Infinity,0.37]],
      hoh:    [[17000,0.10],[64850,0.12],[103350,0.22],[197300,0.24],[250500,0.32],[626350,0.35],[Infinity,0.37]],
    },
    // Long-term capital gains and qualified dividends: taxable income up to the
    // first figure is taxed at 0%, up to the second at 15%, above it at 20%.
    capitalGains: {
      single: [48350, 533400],
      mfj:    [96700, 600050],
      mfs:    [48350, 300000],
      hoh:    [64750, 566700],
    },
  },
  2026: {
    sourced: true,
    reviewed: false,
    reviewedBy: null,
    reviewedOn: null,
    source: 'Rev. Proc. 2025-32, section 4.01 tables 1-4 (pages 10-12) and section 4.03 (page 13). https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
    // Transcribed from the Revenue Procedure itself, which states each band as a
    // base amount plus a rate on the excess. Stored here as the ceiling of each
    // band, which is the same schedule expressed the other way round.
    ordinary: {
      // Table 3 — Unmarried Individuals (other than Surviving Spouses and Heads of Households)
      single: [[12400,0.10],[50400,0.12],[105700,0.22],[201775,0.24],[256225,0.32],[640600,0.35],[Infinity,0.37]],
      // Table 1 — Married Individuals Filing Joint Returns and Surviving Spouses
      mfj:    [[24800,0.10],[100800,0.12],[211400,0.22],[403550,0.24],[512450,0.32],[768700,0.35],[Infinity,0.37]],
      // Table 4 — Married Individuals Filing Separate Returns
      mfs:    [[12400,0.10],[50400,0.12],[105700,0.22],[201775,0.24],[256225,0.32],[384350,0.35],[Infinity,0.37]],
      // Table 2 — Heads of Households
      hoh:    [[17700,0.10],[67450,0.12],[105700,0.22],[201750,0.24],[256200,0.32],[640600,0.35],[Infinity,0.37]],
    },
    // Section 4.03 — maximum zero rate and maximum 15 percent rate amounts.
    capitalGains: {
      single: [49450, 545500],   // "All Other Individuals"
      mfj:    [98900, 613700],
      mfs:    [49450, 306850],
      hoh:    [66200, 579600],
    },
    // Not used by the calculation, recorded because the worksheet's deduction
    // line is typed and this is what it should agree with.
    standardDeduction: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150 },
  },
};

const round = (x) => Math.round(x * 100) / 100;

function taxOnOrdinary(amount, bands) {
  let tax = 0, lower = 0;
  for (const [upTo, rate] of bands) {
    if (amount <= lower) break;
    tax += (Math.min(amount, upTo) - lower) * rate;
    lower = upTo;
  }
  return tax;
}

// Ordinary income and preferential income are taxed on separate schedules, with
// the preferential slice sitting ON TOP of the ordinary one. Taxing the whole
// taxable income at ordinary rates overstates the bill whenever there are gains;
// taxing them separately from zero understates it. Both are wrong in ways that
// look reasonable, so the stacking is done explicitly here.
export function federalTax({ taxableIncome, filingStatus, year, preferentialIncome = 0 }) {
  const table = TAX_YEARS[year];
  if (!table) {
    return { available: false, reason: `Rates for ${year} are not loaded. Enter the tax figure by hand, or add and review the year in src/taxrates.js.` };
  }
  const bands = table.ordinary[filingStatus];
  const cgBreaks = table.capitalGains[filingStatus];
  if (!bands || !cgBreaks) {
    return { available: false, reason: `No ${year} rates for filing status "${filingStatus}".` };
  }

  const total = Math.max(0, Number(taxableIncome) || 0);
  const pref = Math.min(Math.max(0, Number(preferentialIncome) || 0), total);
  const ordinary = total - pref;

  const ordinaryTax = taxOnOrdinary(ordinary, bands);

  // The preferential slice is taxed by where it falls once stacked above the
  // ordinary income, not by its own size.
  const [zeroTop, fifteenTop] = cgBreaks;
  let remaining = pref, cursor = ordinary, prefTax = 0;
  const takeAt = (ceiling, rate) => {
    if (remaining <= 0 || cursor >= ceiling) return;
    const slice = Math.min(remaining, ceiling - cursor);
    prefTax += slice * rate;
    remaining -= slice;
    cursor += slice;
  };
  takeAt(zeroTop, 0);
  takeAt(fifteenTop, 0.15);
  prefTax += remaining * 0.20;

  const tax = round(ordinaryTax + prefTax);
  const marginalBand = bands.find(([upTo]) => ordinary < upTo) || bands[bands.length - 1];

  return {
    available: true,
    tax,
    ordinaryIncome: round(ordinary),
    preferentialIncome: round(pref),
    ordinaryTax: round(ordinaryTax),
    preferentialTax: round(prefTax),
    marginalRate: marginalBand[1],
    effectiveRate: total > 0 ? round((tax / total) * 1000) / 10 : 0,
    reviewed: !!table.reviewed,
    sourced: !!table.sourced,
    source: table.source,
    year,
  };
}

export const availableTaxYears = () => Object.keys(TAX_YEARS).map(Number).sort();
