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
// Each year records who checked it and when. An unreviewed year should be
// treated as absent.

export const TAX_YEARS = {
  2025: {
    reviewed: false,          // ← set true only once a CPA has checked every figure
    reviewedBy: null,
    reviewedOn: null,
    source: 'IRS annual inflation adjustments for tax year 2025',
    // [upTo, rate] — the last band uses Infinity.
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
  // 2026 is deliberately absent. Its figures were not confirmed, and a tax tool
  // that guesses a bracket is worse than one that admits it does not know.
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
    year,
  };
}

export const availableTaxYears = () => Object.keys(TAX_YEARS).map(Number).sort();
