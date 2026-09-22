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
export const PAID_BY = [
  { key: 'individual', label: 'The individual' },
  { key: 'entity', label: 'A pass-through entity, on their behalf' },
  { key: 'split', label: 'Split between entity and individual' },
];

export const MN_LINES = [
  { k: 'hdr_mnti', l: 'Minnesota taxable income', t: 'header' },
  { k: 'federal_agi', l: 'Federal adjusted gross income', t: 'linked', from: 'agi',
    note: 'Pulled from the federal worksheet so the two cannot disagree.' },
  { k: 'other_additions', l: 'Other additions', t: 'input' },
  { k: 'additions_adjustment', l: 'Additions adjustment', t: 'memo', depth: 1,
    note: 'Already included in Other additions — recorded for reference, never added again.' },
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
  { k: 'tax_before_credits', l: 'Tax before credits', t: 'sum', of: ['resident_tax', 'other_taxes'] },
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

const n = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const round = (x) => Math.round(x * 100) / 100;

// `federal` is the computed federal worksheet, used to resolve `linked` lines.
export function computeStateWorksheet(stateCode, values = {}, federal = null, opts = {}) {
  const lines = STATE_LINES[stateCode];
  if (!lines) return null;
  const out = {};

  for (const line of lines) {
    if (line.t === 'header') continue;
    const v = { prior: 0, diff: 0 };
    if (line.t === 'linked') {
      const src = federal?.lines?.[line.from];
      v.prior = src ? src.prior : 0;
      v.diff = src ? src.diff : 0;
    } else if (line.t === 'sum') {
      for (const c of ['prior', 'diff']) v[c] = round((line.of || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
    } else if (line.t === 'calc') {
      for (const c of ['prior', 'diff']) {
        v[c] = round((line.plus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0)
                   - (line.minus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
      }
    } else {
      const entered = values[line.k] || {};
      v.prior = round(n(entered.prior));
      v.diff = round(n(entered.diff));
    }
    v.baseline = round(v.prior + v.diff);
    // Clamping applies per column, so a refund line reads 0 rather than a
    // negative amount owed, matching how the figures are presented on a return.
    if (line.clampMin != null) {
      for (const c of ['prior', 'diff', 'baseline']) {
        if (c !== 'diff') v[c] = Math.max(line.clampMin, v[c]);
      }
      v.diff = round(v.baseline - v.prior);
    }
    out[line.k] = v;
  }

  const at = (k, c) => (out[k] ? out[k][c] : 0);
  // What still has to be paid in, excluding penalty and late charges — those are
  // consequences of a past shortfall, not part of a forward payment schedule.
  const remaining = round(at('net_tax_due', 'baseline') - at('total_payments', 'baseline'));
  const paidBy = opts.paidBy || 'individual';
  const entityShare = round(n(opts.entityShare));

  let individualQuarterly, entityQuarterly;
  if (paidBy === 'entity') {
    individualQuarterly = 0;
    entityQuarterly = round(Math.max(0, remaining) / 4);
  } else if (paidBy === 'split') {
    const entityAnnual = Math.min(Math.max(0, entityShare), Math.max(0, remaining));
    entityQuarterly = round(entityAnnual / 4);
    individualQuarterly = round(Math.max(0, remaining - entityAnnual) / 4);
  } else {
    individualQuarterly = round(Math.max(0, remaining) / 4);
    entityQuarterly = 0;
  }

  return {
    state: stateCode,
    lines: out,
    remaining: Math.max(0, remaining),
    paidBy,
    quarterly: { individual: individualQuarterly, entity: entityQuarterly },
    // Stated in words so the recommendation can be audited rather than trusted.
    basis: paidBy === 'entity'
      ? `The electing entity remits these payments. The individual is not scheduled to pay ${stateCode} estimates; their credit appears on the pass-through entity tax credit line.`
      : paidBy === 'split'
        ? `Entity remits ${entityQuarterly.toLocaleString()} per quarter; the individual remits the remaining ${individualQuarterly.toLocaleString()}.`
        : `The individual remits these payments directly.`,
  };
}
