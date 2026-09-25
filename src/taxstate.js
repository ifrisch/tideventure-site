// State estimated tax worksheets.
//
// Two things make these different from the federal sheet:
//
// 1. A state worksheet is DOWNSTREAM of the federal one. Its first line is
//    federal AGI, pulled across rather than re-entered, so the two can never
//    disagree. That is the `linked` kind below.
//
// 2. The person the worksheet is about is not always the person who pays.
//    Where a pass-through entity elects to pay state tax on its owners'
//    behalf, the entity writes the cheques and the owner takes a credit. The
//    tax math is unchanged by this; what changes is who we tell to pay. So it
//    is modelled as `paidBy` on the worksheet — presentation, not arithmetic —
//    and an individual whose entity pays must never be handed a payment
//    schedule they should not act on.
//
// Line kinds match the federal sheet: input, memo, sum, taxrule. Added here:
//   linked  value comes from the federal worksheet; never editable
//   calc    plus[] minus[], with optional clampMin — for lines like "amount you
//           owe" that floor at zero and have a mirror-image refund line

export const STATES = {
  MN: { code: 'MN', name: 'Minnesota', hasIndividualIncomeTax: true },
  IA: { code: 'IA', name: 'Iowa', hasIndividualIncomeTax: true },
  TN: { code: 'TN', name: 'Tennessee', hasIndividualIncomeTax: false,
        note: 'No individual income tax on wage and investment income, so no individual estimated payment worksheet. Confirm before relying on this for a given client.' },
};

// Who actually remits the state estimated payments.
//
// This is NOT a branch through the arithmetic, and it deliberately has no
// "amount the entity covers" field of its own. That amount is already on the
// worksheet as the pass-through entity tax credit, which sits inside total
// payments — so entering it there reduces what the individual still owes by
// exactly the right amount, with no second figure that could disagree with it.
// The setting below only controls whether an entity payment schedule is shown
// alongside the individual's.
export const PAID_BY = [
  { key: 'individual', label: 'The individual only' },
  { key: 'entity', label: 'An entity pays the pass-through portion' },
];

// Income lines whose tax an electing entity would typically cover — used only
// to offer a proportional cross-check against the entity's own PTE computation.
const PASSTHROUGH_INCOME_KEYS = ['scorp_income', 'partnership_income'];

export const MN_LINES = [
  { k: 'hdr_mnti', l: 'Minnesota taxable income', t: 'header' },
  { k: 'federal_agi', l: 'Federal adjusted gross income', t: 'linked', from: 'agi',
    note: 'Pulled from the federal worksheet so the two cannot disagree.' },
  { k: 'other_additions', l: 'Other additions', t: 'input' },
  { k: 'additions_adjustment', l: 'Additions adjustment', t: 'memo', depth: 1,
    note: 'Already included in Other additions — recorded for reference, never added again.' },
  { k: 'mn_itemized', l: 'Itemized deductions under Minnesota rules', t: 'input',
    note: 'Minnesota itemized, before the income limitation: property tax capped at $10,000, no state income tax, medical above 10% of AGI. Used only when the calculation is on.' },
  { k: 'itemized_or_standard', l: 'Itemized or standard deduction', t: 'taxrule',
    note: 'Minnesota standard deduction varies by filing status and year.' },
  { k: 'exemptions', l: 'Exemptions', t: 'taxrule' },
  { k: 'state_income_tax_refund', l: 'State income tax refund', t: 'input' },
  { k: 'other_subtractions', l: 'Other subtractions', t: 'input' },
  { k: 'subtractions_adjustment', l: 'Subtractions adjustment', t: 'memo', depth: 1,
    note: 'Already included in Other subtractions — recorded for reference, never subtracted again.' },
  { k: 'total_subtractions', l: 'Total subtractions', t: 'sum',
    of: ['itemized_or_standard', 'exemptions', 'state_income_tax_refund', 'other_subtractions'] },
  { k: 'mn_taxable_income', l: 'Minnesota taxable income', t: 'calc', major: true,
    plus: ['federal_agi', 'other_additions'], minus: ['total_subtractions'] },

  { k: 'hdr_tax', l: 'Tax', t: 'header' },
  { k: 'tax', l: 'Tax', t: 'taxrule', note: 'Minnesota bracket computation.' },
  { k: 'amt', l: 'Alternative minimum tax', t: 'taxrule' },
  { k: 'resident_tax', l: 'Resident / part-year / nonresident tax', t: 'sum', of: ['tax', 'amt'] },
  { k: 'other_taxes', l: 'Other taxes', t: 'input' },
  { k: 'mn_niit', l: 'Minnesota net investment income tax', t: 'taxrule',
    note: '1% of Minnesota net investment income above $1,000,000 (Schedule NIIT). In addition to the regular tax.' },
  { k: 'tax_before_credits', l: 'Tax before credits', t: 'sum', of: ['resident_tax', 'other_taxes', 'mn_niit'] },
  { k: 'nonrefundable_credits', l: 'Total nonrefundable credits', t: 'input' },
  { k: 'tax_after_nonrefundable', l: 'Tax after nonrefundable credits', t: 'calc',
    plus: ['tax_before_credits'], minus: ['nonrefundable_credits'] },
  { k: 'wildlife_contribution', l: 'Contribution to nongame wildlife fund', t: 'input' },
  { k: 'net_tax_due', l: 'Net tax due', t: 'sum', major: true,
    of: ['tax_after_nonrefundable', 'wildlife_contribution'] },

  { k: 'hdr_payments', l: 'Payments and credits', t: 'header' },
  { k: 'mn_withheld', l: 'Minnesota income tax withheld', t: 'input' },
  { k: 'mn_est_and_ext', l: 'Minnesota estimated tax and extension payment', t: 'input' },
  { k: 'pte_credit', l: 'Pass-through entity tax credit', t: 'input',
    note: 'Owner\'s share of state tax paid by an electing entity. Set "paid by" to the entity when this applies.' },
  { k: 'refundable_credits', l: 'Other refundable credits', t: 'input' },
  { k: 'total_payments', l: 'Total payments and refundable credits', t: 'sum', major: true,
    of: ['mn_withheld', 'mn_est_and_ext', 'pte_credit', 'refundable_credits'] },

  { k: 'hdr_result', l: 'Refund or amount due', t: 'header' },
  { k: 'underpayment_penalty', l: 'Penalty for underpayment of estimated tax', t: 'taxrule' },
  { k: 'late_filing', l: 'Late filing, payment and interest', t: 'input' },
  { k: 'amount_you_owe', l: 'Amount you owe', t: 'calc', major: true, clampMin: 0,
    plus: ['net_tax_due', 'underpayment_penalty', 'late_filing'], minus: ['total_payments'] },
  { k: 'total_refund', l: 'Total refund', t: 'calc', major: true, clampMin: 0,
    plus: ['total_payments'], minus: ['net_tax_due', 'underpayment_penalty', 'late_filing'] },
];

export const STATE_LINES = { MN: MN_LINES };

// ── Minnesota rate tables ──
// From the research pass, every figure traced to a Minnesota Department of
// Revenue publication (the inflation-adjusted amounts table, the Form M1 / M1SA
// worksheets and the desk reference) and confirmed by the primary-source
// verifier. Checked against the reference worksheet: 2025 taxable income of
// 56,841 gives 3,394 through the tax table, and 2026 taxable income of
// 183,356 gives 12,761.44 — the ProConnect figures are 3,394 and 12,761.
//
// Minnesota taxes long-term capital gains at ORDINARY rates. There is no
// preferential schedule, because the gains arrive inside federal AGI and Form
// M1 has no separate computation for them.
//
// Full-year residents only. A part-year resident or nonresident has the whole
// tax prorated by the Schedule M1NR ratio; that is not modelled, and the
// calculation says so rather than overcharging them.
export const MN_RATES = {
  2025: {
    rates: [0.0535, 0.068, 0.0785, 0.0985],
    // upper edge of each of the first three bands
    bands: { single: [32570, 106990, 198630], mfj: [47620, 189180, 330410],
             mfs: [23810, 94590, 165205], hoh: [40100, 161130, 264050] },
    // Below this, Form M1 line 10 requires the tax table: each $100 band is
    // taxed at its midpoint. Only published for 2025 so far.
    taxTableBelow: 86800,
    standard: { single: 14950, mfs: 14950, mfj: 29900, hoh: 22500 },
    perBox:   { single: 2000, hoh: 2000, mfj: 1550, mfs: 1550 },
    dependentStd: { minimum: 1250, addon: 350 },
    // Deduction limitation: 3% of AGI over T1, 10% over T2, capped at 80% of the
    // deduction; a flat 80% cut above T80. T80 is NOT halved for MFS.
    limit: { t1: 238950, t1mfs: 119475, t2: 330300, t2mfs: 165150, t80: 1083150 },
    exemption: { perDependent: 5200,
                 threshold: { mfj: 358550, hoh: 298800, single: 239050, mfs: 179275 } },
  },
  2026: {
    rates: [0.0535, 0.068, 0.0785, 0.0985],
    bands: { single: [33310, 109430, 203150], mfj: [48700, 193480, 337930],
             mfs: [24350, 96740, 168965], hoh: [41010, 164800, 270060] },
    taxTableBelow: null,   // 2026 table not yet published — the rate formula is used
    standard: { single: 15300, mfs: 15300, mfj: 30600, hoh: 23000 },
    perBox:   { single: 2000, hoh: 2000, mfj: 1600, mfs: 1600 },
    dependentStd: { minimum: 1300, addon: 350 },
    limit: { t1: 244400, t1mfs: 122200, t2: 337800, t2mfs: 168900, t80: 1107750 },
    exemption: { perDependent: 5300,
                 threshold: { mfj: 366700, hoh: 305600, single: 244500, mfs: 183350 } },
  },
};
const MN_NIIT = { threshold: 1000000, rate: 0.01 };

function mnLimit(D, agi, filingStatus, L) {
  const t1 = filingStatus === 'mfs' ? L.t1mfs : L.t1;
  const t2 = filingStatus === 'mfs' ? L.t2mfs : L.t2;
  if (agi <= t1) return 0;
  if (agi > L.t80) return 0.80 * D;
  const formula = 0.03 * Math.max(0, Math.min(agi, t2) - t1) + 0.10 * Math.max(0, agi - t2);
  return Math.min(formula, 0.80 * D);
}

// Minnesota standard vs itemized, AFTER the income limitation. The limitation
// hits the two differently, so choosing before applying it can pick the wrong
// one — a correction the algorithm verifier made to the research.
export function mnDeduction({ year, filingStatus, agi = 0, itemized = 0, profile = {}, earnedIncome = 0 }) {
  const R = MN_RATES[year];
  if (!R) return { available: false, reason: `Minnesota ${year} figures are not loaded.` };
  const boxes = (profile.taxpayer65 ? 1 : 0) + (profile.taxpayerBlind ? 1 : 0)
              + (filingStatus === 'mfj' ? (profile.spouse65 ? 1 : 0) + (profile.spouseBlind ? 1 : 0) : 0);
  let std = R.standard[filingStatus] + boxes * R.perBox[filingStatus];
  // A dependent's Minnesota standard deduction is capped using the SINGLE base,
  // with the aged/blind amounts inside the cap — unlike the federal worksheet.
  if (profile.isDependent) {
    std = Math.min(Math.max(R.dependentStd.minimum, earnedIncome + R.dependentStd.addon),
                   R.standard.single + boxes * R.perBox[filingStatus]);
  }
  if (profile.standardBarred) std = 0;
  const stdAfter = std - mnLimit(std, agi, filingStatus, R.limit);
  // The research notes medical, investment interest and casualty losses are
  // exempt from the itemized limitation. Those components are not separated
  // here, so the limitation is applied to the whole itemized figure — which can
  // understate the deduction for a client with large medical expenses.
  const item = Math.max(0, Number(itemized) || 0);
  const itemAfter = item - mnLimit(item, agi, filingStatus, R.limit);
  const takesItemized = profile.standardBarred ? true : itemAfter > stdAfter;
  return { available: true, amount: round(takesItemized ? itemAfter : stdAfter),
           standard: round(stdAfter), itemized: round(itemAfter), takesItemized };
}

export function mnDependentExemption({ year, filingStatus, agi = 0, dependents = 0, isDependent = false }) {
  const R = MN_RATES[year];
  if (!R) return { available: false };
  // A taxpayer who can be claimed as someone else's dependent gets none.
  if (isDependent || !dependents) return { available: true, amount: 0 };
  const gross = R.exemption.perDependent * dependents;
  const inc = filingStatus === 'mfs' ? 1250 : 2500;
  const excess = Math.max(0, agi - R.exemption.threshold[filingStatus]);
  const pct = excess > 0 ? Math.min(1, 0.02 * Math.ceil(excess / inc)) : 0;
  return { available: true, amount: round(gross * (1 - pct)) };
}

export function mnTax({ year, filingStatus, taxableIncome = 0 }) {
  const R = MN_RATES[year];
  if (!R) return { available: false, reason: `Minnesota ${year} rates are not loaded.` };
  let ti = Math.max(0, Number(taxableIncome) || 0);
  let table = false;
  if (R.taxTableBelow && ti < R.taxTableBelow) { ti = Math.floor(ti / 100) * 100 + 50; table = true; }
  const [b1, b2, b3] = R.bands[filingStatus];
  const [r1, r2, r3, r4] = R.rates;
  const tax = r1 * Math.min(ti, b1) + r2 * Math.max(0, Math.min(ti, b2) - b1)
            + r3 * Math.max(0, Math.min(ti, b3) - b2) + r4 * Math.max(0, ti - b3);
  return { available: true, tax: table ? Math.round(tax) : round(tax), table };
}

const n = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const round = (x) => Math.round(x * 100) / 100;

// Prior and baseline are the entered columns; difference is derived. Older
// records stored {prior, diff} and are read forward rather than migrated.
const enteredColumns = (entered = {}) => {
  const prior = round(n(entered.prior));
  const baseline = entered.baseline != null && entered.baseline !== ''
    ? round(n(entered.baseline))
    : round(prior + n(entered.diff));
  return { prior, baseline };
};

// Lines worked out from Minnesota's published figures when the calculation is on.
const CALC_LINES = new Set(['itemized_or_standard', 'exemptions', 'tax', 'mn_niit']);

// `federal` is the computed federal worksheet, used to resolve `linked` lines.
export function computeStateWorksheet(stateCode, values = {}, federal = null, opts = {}) {
  const lines = STATE_LINES[stateCode];
  if (!lines) return null;
  const out = {};

  for (const line of lines) {
    if (line.t === 'header') continue;
    const v = { prior: 0, baseline: 0 };
    if (line.t === 'linked') {
      const src = federal?.lines?.[line.from];
      v.prior = src ? src.prior : 0;
      v.baseline = src ? src.baseline : 0;
    } else if (line.t === 'sum') {
      for (const c of ['prior', 'baseline']) v[c] = round((line.of || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
    } else if (line.t === 'calc') {
      for (const c of ['prior', 'baseline']) {
        v[c] = round((line.plus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0)
                   - (line.minus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
      }
    } else if (opts.calcTax && CALC_LINES.has(line.k)) {
      // Computed from Minnesota's published figures. Each depends only on lines
      // above it in this list, so the single forward pass is enough.
      for (const c of ['prior', 'baseline']) {
        const yr = c === 'prior' ? (opts.priorYear || (opts.year ? opts.year - 1 : undefined)) : opts.year;
        const fs = opts.filingStatus || 'single';
        const agi = out.federal_agi ? out.federal_agi[c] : 0;
        const prof = opts.profile || {};
        let r;
        if (line.k === 'itemized_or_standard') {
          r = mnDeduction({ year: yr, filingStatus: fs, agi, itemized: out.mn_itemized ? out.mn_itemized[c] : 0,
                            profile: prof, earnedIncome: federal?.lines?.total_wages ? federal.lines.total_wages[c] : 0 });
          if (r.available) v[c] = r.amount;
        } else if (line.k === 'exemptions') {
          r = mnDependentExemption({ year: yr, filingStatus: fs, agi, dependents: Number(prof.dependents) || 0, isDependent: !!prof.isDependent });
          if (r.available) v[c] = r.amount;
        } else if (line.k === 'tax') {
          r = mnTax({ year: yr, filingStatus: fs, taxableIncome: out.mn_taxable_income ? out.mn_taxable_income[c] : 0 });
          if (r.available) v[c] = r.tax;
        } else if (line.k === 'mn_niit') {
          // Minnesota NII starts from the federal figure less U.S. bond interest,
          // which Minnesota does not tax. The $1,000,000 threshold is flat — not
          // halved for married filing separately.
          const fedNii = federal?.surtaxCalc?.[c]?.niit?.nii || 0;
          const usBonds = (federal?.lines?.us_govt_obligations?.[c] || 0) + (federal?.lines?.us_govt_obligations_k1?.[c] || 0);
          v[c] = Math.round(Math.max(0, fedNii - usBonds - MN_NIIT.threshold) * MN_NIIT.rate);
          r = { available: true };
        }
        if (!r || !r.available) {
          // No figures for that year: keep whatever was typed.
          const e = enteredColumns(values[line.k]);
          v[c] = e[c];
        }
      }
    } else {
      const e = enteredColumns(values[line.k]);
      v.prior = e.prior; v.baseline = e.baseline;
    }
    // Clamping applies to the two real columns, so a refund line reads 0 rather
    // than a negative amount owed, matching how a return presents the figures.
    if (line.clampMin != null) {
      v.prior = Math.max(line.clampMin, v.prior);
      v.baseline = Math.max(line.clampMin, v.baseline);
    }
    v.diff = round(v.baseline - v.prior);
    out[line.k] = v;
  }

  const at = (k, c) => (out[k] ? out[k][c] : 0);
  // What still has to be paid in, excluding penalty and late charges — those are
  // consequences of a past shortfall, not part of a forward payment schedule.
  // The entity's PTE payment is already inside total payments, so what is left
  // here is the individual's own obligation with no further adjustment.
  const remaining = round(at('net_tax_due', 'baseline') - at('total_payments', 'baseline'));
  const paidBy = opts.paidBy === 'entity' ? 'entity' : 'individual';
  const pteAnnual = round(at('pte_credit', 'baseline'));

  const individualQuarterly = round(Math.max(0, remaining) / 4);
  const entityQuarterly = paidBy === 'entity' ? round(Math.max(0, pteAnnual) / 4) : 0;

  // A proportional cross-check, NOT a computation of the entity's PTE tax. The
  // entity computes that on its own return under its own rules; this only says
  // what share of the individual's state liability the pass-through income
  // represents, so an entered figure that is wildly off is easy to spot.
  let allocation = null;
  if (paidBy === 'entity' && federal?.lines) {
    const totalIncome = federal.lines.total_income?.baseline || 0;
    const ptIncome = PASSTHROUGH_INCOME_KEYS.reduce((s, k) => s + (federal.lines[k]?.baseline || 0), 0);
    if (totalIncome > 0 && ptIncome > 0) {
      const share = Math.min(1, ptIncome / totalIncome);
      allocation = {
        passthroughIncome: round(ptIncome),
        totalIncome: round(totalIncome),
        sharePercent: round(share * 100),
        impliedEntityTax: round(at('net_tax_due', 'baseline') * share),
      };
    }
  }

  return {
    state: stateCode,
    lines: out,
    remaining: Math.max(0, remaining),
    paidBy,
    pteAnnual,
    allocation,
    quarterly: { individual: individualQuarterly, entity: entityQuarterly },
    // Stated in words so the recommendation can be audited rather than trusted.
    basis: paidBy === 'entity'
      ? `The entity remits ${pteAnnual.toLocaleString()} for the year (${entityQuarterly.toLocaleString()} per quarter) as pass-through entity tax. That credit is already counted in total payments, so the individual's own ${individualQuarterly.toLocaleString()} per quarter covers only what is left — their non-pass-through income.`
      : `The individual remits these payments directly.`,
  };
}
