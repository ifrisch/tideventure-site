// Pass-through entity worksheets (S corporation, partnership).
//
// An entity worksheet is NOT a smaller version of an individual's. Two
// structural differences drive everything here:
//
// 1. STATE ONLY. A pass-through entity does not make federal estimated income
//    tax payments — the income is taxed to the owners. So there is no federal
//    section at all, and none should be added by analogy. (Entity-level federal
//    taxes such as built-in gains exist but are not estimated-payment items and
//    are out of scope; if one applies, it belongs on the entity return, not
//    here.)
//
// 2. IT HAS OWNERS. The entity computes one pass-through entity tax and remits
//    it, but that amount is allocated among owners, and each owner's share
//    becomes the PTE credit on their individual state return. That allocation
//    is the link between this worksheet and theirs — which is the whole point
//    of building it. Without it the same figure gets typed on two worksheets
//    and they drift.

export const ENTITY_TYPES = [
  { key: 'scorp', label: 'S Corporation' },
  { key: 'partnership', label: 'Partnership' },
];

export const ENTITY_STATES = { MN: 'Minnesota' };

// Same line kinds as elsewhere: input, memo, taxrule, sum, calc.
export const ENTITY_LINES = {
  MN: [
    { k: 'hdr_income', l: 'Minnesota pass-through entity tax', t: 'header' },
    { k: 'mn_source_income', l: 'Minnesota source income', t: 'input',
      note: 'Entity-level income apportioned to Minnesota.' },
    { k: 'pte_adjustments', l: 'Adjustments to Minnesota source income', t: 'input' },
    { k: 'pte_base', l: 'Income subject to pass-through entity tax', t: 'sum',
      of: ['mn_source_income', 'pte_adjustments'] },
    { k: 'pte_tax', l: 'Pass-through entity tax', t: 'taxrule', major: true,
      note: 'Computed on the entity return under Minnesota\'s own rules. Enter the figure from that computation — this tool does not derive it.' },

    { k: 'hdr_payments', l: 'Payments already made', t: 'header' },
    { k: 'overpayment_applied', l: 'Overpayment applied from prior year', t: 'input' },
    { k: 'q1_paid', l: 'Q1 payment made', t: 'input' },
    { k: 'q2_paid', l: 'Q2 payment made', t: 'input' },
    { k: 'q3_paid', l: 'Q3 payment made', t: 'input' },
    { k: 'q4_paid', l: 'Q4 payment made', t: 'input' },
    { k: 'extension_payment', l: 'Paid with extension', t: 'input' },
    { k: 'total_paid', l: 'Total paid to date', t: 'sum', major: true,
      of: ['overpayment_applied', 'q1_paid', 'q2_paid', 'q3_paid', 'q4_paid', 'extension_payment'] },

    { k: 'remaining', l: 'Remaining to pay', t: 'calc', major: true, clampMin: 0,
      plus: ['pte_tax'], minus: ['total_paid'] },
  ],
};

const n = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const round = (x) => Math.round(x * 100) / 100;

// Prior and baseline are entered; difference is derived. Older records stored
// {prior, diff} and are read forward rather than migrated.
const enteredColumns = (entered = {}) => {
  const prior = round(n(entered.prior));
  const baseline = entered.baseline != null && entered.baseline !== ''
    ? round(n(entered.baseline))
    : round(prior + n(entered.diff));
  return { prior, baseline };
};

export function computeEntityWorksheet(stateCode, values = {}, owners = []) {
  const lines = ENTITY_LINES[stateCode];
  if (!lines) return null;
  const out = {};

  for (const line of lines) {
    if (line.t === 'header') continue;
    const v = { prior: 0, baseline: 0 };
    if (line.t === 'sum') {
      for (const c of ['prior', 'baseline']) v[c] = round((line.of || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
    } else if (line.t === 'calc') {
      for (const c of ['prior', 'baseline']) {
        v[c] = round((line.plus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0)
                   - (line.minus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
      }
    } else {
      const e = enteredColumns(values[line.k]);
      v.prior = e.prior; v.baseline = e.baseline;
    }
    if (line.clampMin != null) {
      v.prior = Math.max(line.clampMin, v.prior);
      v.baseline = Math.max(line.clampMin, v.baseline);
    }
    v.diff = round(v.baseline - v.prior);
    out[line.k] = v;
  }

  const pteTax = out.pte_tax ? out.pte_tax.baseline : 0;
  const remaining = out.remaining ? out.remaining.baseline : 0;

  // Allocate to owners. Ownership percentage drives a suggested share, but each
  // owner's amount can be overridden because real allocations do not always
  // follow ownership exactly. Whatever the source, the allocation is reconciled
  // against the entity's own tax below — a mismatch is surfaced rather than
  // silently absorbed, because the gap would otherwise appear as a missing
  // credit on somebody's individual return.
  const allocations = (Array.isArray(owners) ? owners : []).slice(0, 25).map(o => {
    const pct = round(n(o.ownershipPercent));
    const suggested = round(pteTax * (pct / 100));
    const hasOverride = o.allocatedPte !== '' && o.allocatedPte != null;
    const allocated = hasOverride ? round(n(o.allocatedPte)) : suggested;
    return {
      email: String(o.email || '').toLowerCase().trim(),
      name: String(o.name || '').slice(0, 120),
      ownershipPercent: pct,
      suggested,
      allocated,
      overridden: hasOverride && allocated !== suggested,
      quarterly: round(allocated / 4),
    };
  });

  const totalPercent = round(allocations.reduce((s, a) => s + a.ownershipPercent, 0));
  const totalAllocated = round(allocations.reduce((s, a) => s + a.allocated, 0));
  const unallocated = round(pteTax - totalAllocated);

  const warnings = [];
  if (allocations.length && Math.abs(totalPercent - 100) > 0.01) {
    warnings.push(`Ownership percentages total ${totalPercent}%, not 100%.`);
  }
  if (allocations.length && Math.abs(unallocated) > 1) {
    warnings.push(`${Math.abs(unallocated).toLocaleString()} of the ${pteTax.toLocaleString()} entity tax is ${unallocated > 0 ? 'not allocated to any owner' : 'allocated beyond the entity tax'}. Every dollar the entity pays should land on somebody's return as a credit.`);
  }

  return {
    state: stateCode,
    lines: out,
    pteTax,
    remaining,
    quarterly: round(Math.max(0, remaining) / 4),
    allocations,
    totalPercent,
    totalAllocated,
    unallocated,
    warnings,
    basis: `The entity owes ${pteTax.toLocaleString()} of Minnesota pass-through entity tax for the year and has paid ${(out.total_paid ? out.total_paid.baseline : 0).toLocaleString()}, leaving ${remaining.toLocaleString()} — ${round(Math.max(0, remaining) / 4).toLocaleString()} per remaining quarter. No federal estimated payments: the income is taxed to the owners.`,
  };
}
