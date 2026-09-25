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

// OBBBA senior deduction, IRC sec. 151(d)(5)(C). A flat statutory amount — not
// inflation-indexed — for tax years 2025 through 2028.
const SENIOR_DEDUCTION = {
  perPerson: 6000,
  // The reduced amount is 6% of MAGI above the threshold. The $150,000
  // threshold applies ONLY to a joint return (sec. 151(d)(5)(C)(iii)(I);
  // Schedule 1-A line 32). A qualifying surviving spouse takes the joint
  // standard deduction and joint brackets but the $75,000 senior threshold,
  // because they do not file a joint return — the first research pass got
  // this wrong and two independent verifiers caught it.
  thresholdJoint: 150000,
  thresholdOther: 75000,
  rate: 0.06,
};

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
    // As AMENDED by the OBBBA: Rev. Proc. 2025-32 sec. 3.01 replaced the 2025
    // base amounts. The aged/blind and dependent figures come from Rev. Proc.
    // 2024-40 secs. 2.15(2) and 2.15(3), which that amendment left in force.
    standardDeduction: { single: 15750, mfj: 31500, mfs: 15750, hoh: 23625 },
    additionalPerUnit:  { single: 2000, hoh: 2000, mfj: 1600, mfs: 1600 },
    dependentFloor: 1350,
    dependentAddon: 450,
    senior: SENIOR_DEDUCTION,
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
    // Rev. Proc. 2025-32 sec. 4.14(1)-(3).
    standardDeduction: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150 },
    additionalPerUnit:  { single: 2050, hoh: 2050, mfj: 1650, mfs: 1650 },
    dependentFloor: 1350,
    dependentAddon: 450,
    senior: SENIOR_DEDUCTION,
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

// Standard deduction, IRC sec. 63(c). Returns the amount for line 12e BEFORE the
// comparison with itemized deductions, which the worksheet does.
//
// `barred` is the sec. 63(c)(6) case — married filing separately where either
// spouse itemizes, a nonresident alien, or a short year. It zeroes the ENTIRE
// standard deduction, including the aged/blind additional amount: sec. 63(c)(1)
// defines the standard deduction as the sum of both, so zeroing only the base
// would leave a phantom deduction. The first research pass made that mistake.
export function standardDeduction({ year, filingStatus, taxpayer65 = false, spouse65 = false,
  taxpayerBlind = false, spouseBlind = false, isDependent = false, earnedIncome = 0, barred = false }) {
  const t = TAX_YEARS[year];
  if (!t || !t.standardDeduction) return { available: false, reason: `No ${year} standard deduction loaded.` };
  const base0 = t.standardDeduction[filingStatus];
  if (base0 == null) return { available: false, reason: `No ${year} standard deduction for "${filingStatus}".` };
  if (barred) return { available: true, amount: 0, base: 0, units: 0, note: 'Barred under sec. 63(c)(6) — the whole standard deduction is zero.' };

  // A dependent's basic amount is capped at the greater of the floor or earned
  // income plus the add-on, and never above the normal base.
  const base = isDependent
    ? Math.min(base0, Math.max(t.dependentFloor, (Number(earnedIncome) || 0) + t.dependentAddon))
    : base0;

  // Spouse units count only on a joint return here. On a separate return they
  // can count when the spouse had no gross income and is nobody's dependent
  // (sec. 63(f)(1)(B)); that case is not modelled.
  const units = (taxpayer65 ? 1 : 0) + (taxpayerBlind ? 1 : 0)
              + (filingStatus === 'mfj' ? (spouse65 ? 1 : 0) + (spouseBlind ? 1 : 0) : 0);
  const perUnit = t.additionalPerUnit[filingStatus];
  return { available: true, amount: round(base + units * perUnit), base, units, perUnit };
}

// OBBBA senior deduction, sec. 151(d)(5)(C). Reported on Schedule 1-A.
//
// ORDERING MATTERS: this must come off BEFORE the qualified business income
// deduction's 20%-of-taxable-income limitation is computed. Form 8995 line 11
// is "Form 1040 line 11a minus lines 12e and 13b", and 13b is the Schedule 1-A
// total this lands in. Treating it as independent of the QBI cap overstates the
// cap. The worksheet puts it inside the deductions line — which is also how
// ProConnect presents it — so the QBI base is correct by construction.
//
// Assumes a valid work-authorised SSN issued before the return due date, which
// sec. 151(d)(5)(C)(iv) requires; that is not tested.
export function seniorDeduction({ year, filingStatus, magi = 0, taxpayer65 = false, spouse65 = false }) {
  const t = TAX_YEARS[year];
  if (!t || !t.senior) return { available: false, reason: `No ${year} senior deduction loaded.` };
  // Married taxpayers must file jointly to claim it at all.
  if (filingStatus === 'mfs') return { available: true, amount: 0, count: 0, note: 'Not allowed on a separate return.' };
  const count = (taxpayer65 ? 1 : 0) + (filingStatus === 'mfj' && spouse65 ? 1 : 0);
  if (!count) return { available: true, amount: 0, count: 0 };
  const threshold = filingStatus === 'mfj' ? t.senior.thresholdJoint : t.senior.thresholdOther;
  const reduction = Math.max(0, (Number(magi) || 0) - threshold) * t.senior.rate;
  // The reduction runs against EACH individual's $6,000 separately (Schedule
  // 1-A computes it once, then enters the one reduced figure per person).
  const per = Math.max(0, t.senior.perPerson - reduction);
  return { available: true, amount: round(per * count), count, per: round(per), threshold };
}

// ── Net investment income tax, IRC sec. 1411 ──
// Thresholds are written into the statute and are NOT inflation-indexed, so
// they are the same in every year (confirmed against the 2026 draft Form 8960).
export const NIIT_THRESHOLD = { single: 200000, hoh: 200000, mfj: 250000, mfs: 125000 };
export const NIIT_RATE = 0.038;

// 3.8% of the LESSER of net investment income and MAGI over the threshold.
// The caller decides what is investment income — see taxworksheet.js, where the
// material-participation question for each K-1 is answered.
export function netInvestmentIncomeTax({ filingStatus, magi = 0, netInvestmentIncome = 0 }) {
  const threshold = NIIT_THRESHOLD[filingStatus] ?? 200000;
  const excess = Math.max(0, (Number(magi) || 0) - threshold);
  const nii = Math.max(0, Number(netInvestmentIncome) || 0);
  const base = Math.min(nii, excess);
  return { tax: Math.round(base * NIIT_RATE), threshold, excess: round(excess), nii: round(nii), base: round(base) };
}

// ── Additional Medicare tax, IRC secs. 3101(b)(2) and 1401(b)(2) ──
// Same statutory, unindexed thresholds. Applies to wages and self-employment
// income only — S corporation distributive income is neither, so it never
// counts here however large it is.
export const ADDL_MEDICARE_THRESHOLD = { single: 200000, hoh: 200000, mfj: 250000, mfs: 125000 };
export const ADDL_MEDICARE_RATE = 0.009;

// Form 8959 order: wages first, then self-employment income against whatever
// threshold the wages did not use. Self-employment earnings must already be
// floored PER PERSON before they arrive here — adding a loss for one spouse to
// a profit for the other and flooring the total lets the loss cancel tax the
// other spouse owes, which the IRS rules forbid.
export function additionalMedicareTax({ filingStatus, wages = 0, seEarnings = 0 }) {
  const threshold = ADDL_MEDICARE_THRESHOLD[filingStatus] ?? 200000;
  const w = Math.max(0, Number(wages) || 0);
  const se = Math.max(0, Number(seEarnings) || 0);
  const onWages = Math.max(0, w - threshold) * ADDL_MEDICARE_RATE;
  const seThreshold = Math.max(0, threshold - w);
  const onSe = Math.max(0, se - seThreshold) * ADDL_MEDICARE_RATE;
  return { tax: round(onWages + onSe), onWages: round(onWages), onSe: round(onSe), threshold };
}

export const availableTaxYears = () => Object.keys(TAX_YEARS).map(Number).sort();
