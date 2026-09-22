// Schedule K-1 (1120S) detail — a calculating sub-worksheet, not a record.
//
// Each K-1 produces figures that land on SEVERAL different lines of the
// individual's return, not just the S-corporation income line. That is the
// whole reason this drives rather than documents:
//
//   ordinary income - Section 179      -> S corporation income
//   interest income                    -> Interest income
//   ordinary dividends                 -> Dividend income
//   portfolio/passive short-term gains -> Short-term capital gain from passthrough
//   portfolio/passive long-term gains  -> Long-term capital gain from passthrough
//   Section 1231 and ordinary gains    -> Other gains or losses
//
// All six were verified against a real worksheet before this file was written.
// The net profit relationship in particular — ordinary income minus Section 179,
// with nothing else subtracted — reproduces both columns exactly:
//   prior    107,924 - 178,664 = -70,740
//   current  145,340 -  71,344 =  73,996
// Investment interest expense is NOT part of it; it lands elsewhere on the
// return, which is why it is a memo here.
//
// Tax-exempt interest (municipal) is likewise a memo: including it would
// overstate taxable interest, and the reference worksheet proves it is excluded
// (own interest 42 + K-1 interest 557 = 599, with 431 of munis left out).

export const K1_LINES = [
  { k: 'hdr_general', l: 'General information', t: 'header' },
  { k: 'ein', l: 'EIN', t: 'text' },
  { k: 'ownership_percent', l: 'Ownership percentage', t: 'input', note: 'Percentage, not a dollar amount.' },
  { k: 'passive_activity', l: 'Passive activity', t: 'bool' },
  { k: 'actively_participated', l: 'Actively participated in real estate', t: 'bool' },
  { k: 'real_estate_professional', l: 'Real estate professional', t: 'bool' },

  { k: 'hdr_income', l: 'Income', t: 'header' },
  { k: 'ordinary_income', l: 'Ordinary income (loss)', t: 'input', drives: 'scorp' },
  { k: 'rental_real_estate', l: 'Rental real estate income (loss)', t: 'input' },
  { k: 'other_rental', l: 'Other rental income (loss)', t: 'input' },
  { k: 'interest_income', l: 'Interest income', t: 'input', drives: 'interest' },
  { k: 'us_obligations', l: 'U.S. obligations', t: 'memo' },
  { k: 'ordinary_dividends', l: 'Ordinary dividends', t: 'input', drives: 'dividends' },
  { k: 'qualified_dividends', l: 'Qualified dividends', t: 'memo',
    note: 'A subset of ordinary dividends — recorded, never added on top.' },
  { k: 'muni_total', l: 'Total municipal bonds', t: 'memo',
    note: 'Tax-exempt. Excluded from taxable interest.' },
  { k: 'muni_instate', l: 'In-state municipal bond interest', t: 'memo' },
  { k: 'portfolio_st_gain', l: 'Portfolio short-term capital gains', t: 'input', drives: 'stGain' },
  { k: 'passive_st_gain', l: 'Passive short-term capital gains', t: 'input', drives: 'stGain' },
  { k: 'portfolio_lt_gain', l: 'Portfolio long-term capital gains', t: 'input', drives: 'ltGain' },
  { k: 'passive_lt_gain', l: 'Passive long-term capital gains', t: 'input', drives: 'ltGain' },
  { k: 'portfolio_lt_28', l: 'Portfolio long-term 28% gain', t: 'memo',
    note: 'Rate bucket already inside the long-term figure.' },
  { k: 'passive_lt_28', l: 'Passive long-term 28% gain', t: 'memo', note: 'Rate bucket.' },
  { k: 'unrecaptured_1250', l: 'Unrecaptured 1250 gain', t: 'memo', note: 'Rate bucket.' },
  { k: 'unrecaptured_1250_div', l: 'Unrecaptured 1250 gain — 1099-DIV', t: 'memo', note: 'Rate bucket.' },
  { k: 'nonpassive_1231', l: 'Nonpassive Section 1231 gain', t: 'input', drives: 'ordinaryGain' },
  { k: 'passive_1231', l: 'Passive Section 1231 gain', t: 'input', drives: 'ordinaryGain' },
  { k: 'sec1256', l: 'Section 1256 gain (loss)', t: 'input' },
  { k: 'nonpassive_ordinary_gain', l: 'Nonpassive ordinary gain (loss)', t: 'input', drives: 'ordinaryGain' },
  { k: 'passive_ordinary_gain', l: 'Passive ordinary gain (loss)', t: 'input', drives: 'ordinaryGain' },
  { k: 'deductible_gain_override', l: 'Deductible gain (loss) override', t: 'input' },

  { k: 'hdr_deductions', l: 'Deductions', t: 'header' },
  { k: 'investment_interest', l: 'Investment interest expense', t: 'memo',
    note: 'Not subtracted from K-1 net profit — it is deducted elsewhere on the return.' },
  { k: 'investment_interest_sche', l: 'Investment interest expense — Sch E', t: 'memo' },
  { k: 'portfolio_deductions_2pct', l: 'Deductions related to portfolio income (2%)', t: 'memo' },
  { k: 'portfolio_deductions_other', l: 'Deductions related to portfolio income (other)', t: 'memo' },
  { k: 'sec179_carryover', l: 'Section 179 carryover', t: 'input' },
  { k: 'sec179_deduction', l: 'Section 179 deduction', t: 'input', drives: 'scorp',
    note: 'Subtracted from ordinary income to give K-1 net profit (loss).' },
  { k: 'amt_sec179_carryover', l: 'AMT Section 179 carryover', t: 'memo' },
  { k: 'cost_depletion', l: 'Cost depletion', t: 'memo' },
  { k: 'percentage_depletion', l: 'Percentage depletion', t: 'memo' },

  { k: 'net_profit', l: 'Net profit (loss)', t: 'calc', major: true,
    plus: ['ordinary_income'], minus: ['sec179_deduction'] },

  { k: 'hdr_qbi', l: 'Deduction for qualified business income', t: 'header' },
  { k: 'publicly_traded', l: 'Publicly traded partnership', t: 'bool' },
  { k: 'specified_trade', l: 'Specified trade or business', t: 'bool' },
  { k: 'qbi', l: 'Qualified business income (loss)', t: 'input' },
  { k: 'wages_allocable_qbi', l: 'Wages allocable to QBI', t: 'input' },
  { k: 'ubia', l: 'Unadjusted basis of qualified property', t: 'input' },
  { k: 'dpad_coop', l: 'DPAD received from co-op', t: 'input' },
  { k: 'qbi_allocable_coop', l: 'QBI allocable to co-op', t: 'input' },
  { k: 'wages_allocable_coop', l: 'Wages allocable to co-op', t: 'input' },
  { k: 'sec199a_reit_dividends', l: 'Section 199A REIT dividends', t: 'input' },
  { k: 'aggregate_business_number', l: 'Aggregate business number', t: 'memo' },

  { k: 'hdr_other', l: 'Other information', t: 'header' },
  { k: 'se_health_premiums', l: 'Self-employed health insurance premiums', t: 'input' },

  // ── Basis limitation ──
  // Recorded, and the one relationship the reference proves is computed. The
  // ending basis is NOT derived: in the reference, 572,367 of basis available
  // for limitation becomes 364,229 at year end, a 208,138 movement that no
  // visible row accounts for. Deriving it would mean inventing the ordering
  // rules, so it is entered from the basis schedule instead.
  { k: 'hdr_basis', l: 'Basis limitation', t: 'header' },
  { k: 'beginning_stock_basis', l: 'Beginning stock basis', t: 'input' },
  { k: 'additional_invested', l: 'Additional amounts invested', t: 'input' },
  { k: 'increases_to_basis', l: 'Increases to basis', t: 'input' },
  { k: 'basis_current_year_income', l: 'Current year income', t: 'input' },
  { k: 'distributions', l: 'Distributions or other decreases', t: 'input' },
  { k: 'stock_basis_used', l: 'Stock basis used for limitation', t: 'calc',
    plus: ['beginning_stock_basis', 'additional_invested', 'increases_to_basis', 'basis_current_year_income'],
    minus: ['distributions'] },
  { k: 'decreases_to_basis', l: 'Decreases to basis', t: 'input' },
  { k: 'business_credits_reduce_basis', l: 'Business credits that reduce basis', t: 'input' },
  { k: 'less_debt_basis_restoration', l: 'Less debt basis restoration', t: 'input' },
  { k: 'stock_basis_end', l: 'Stock basis at end of year', t: 'taxrule',
    note: 'Entered from the basis schedule. Loss and deduction ordering rules determine this and are not modelled here.' },
  { k: 'loan_balance_beginning', l: 'Loan balance beginning of year', t: 'input' },
  { k: 'additional_loans', l: 'Additional loans', t: 'input' },
  { k: 'principal_repayment', l: 'Principal portion of debt repayment', t: 'input' },
  { k: 'debt_basis', l: 'Debt basis', t: 'calc',
    plus: ['loan_balance_beginning', 'additional_loans'], minus: ['principal_repayment'] },
  { k: 'adjustments_debt_basis', l: 'Adjustments to debt basis', t: 'input' },
  { k: 'debt_basis_restoration', l: 'Debt basis restoration', t: 'input' },
  { k: 'nontaxable_debt_repayment', l: 'Nontaxable debt repayment', t: 'input' },
  { k: 'debt_basis_used', l: 'Debt basis used for limitation', t: 'input' },
  { k: 'loss_allowed_by_debt_basis', l: 'Loss allowed by debt basis', t: 'input' },
  { k: 'st_gain_loan_repayment', l: 'ST capital gain on loan repayment', t: 'input', drives: 'stGain' },
  { k: 'lt_gain_loan_repayment', l: 'LT capital gain on loan repayment', t: 'input', drives: 'ltGain' },
  { k: 'ordinary_gain_loan_repayment', l: 'Ordinary gain on loan repayment', t: 'input', drives: 'ordinaryGain' },

  { k: 'hdr_passive', l: 'Prior year unallowed passive losses', t: 'header' },
  { k: 'passive_loss_carryover', l: 'Passive loss carryover', t: 'input' },
];

export const K1_LINE_BY_KEY = Object.fromEntries(K1_LINES.map(l => [l.k, l]));

const n = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const round = (x) => Math.round(x * 100) / 100;
const cols = (e = {}) => {
  const prior = round(n(e.prior));
  const baseline = e.baseline != null && e.baseline !== '' ? round(n(e.baseline)) : round(prior + n(e.diff));
  return { prior, baseline };
};

// Compute one K-1's detail and the figures it sends to the individual's return.
export function computeK1(values = {}) {
  const out = {};
  for (const line of K1_LINES) {
    if (line.t === 'header' || line.t === 'text' || line.t === 'bool') continue;
    const v = { prior: 0, baseline: 0 };
    if (line.t === 'calc') {
      for (const c of ['prior', 'baseline']) {
        v[c] = round((line.plus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0)
                   - (line.minus || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
      }
    } else {
      const e = cols(values[line.k]);
      v.prior = e.prior; v.baseline = e.baseline;
    }
    v.diff = round(v.baseline - v.prior);
    out[line.k] = v;
  }

  const sum = (keys, c) => round(keys.reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
  const flow = (keys) => ({ prior: sum(keys, 'prior'), baseline: sum(keys, 'baseline') });

  return {
    lines: out,
    // Where each figure lands on the individual's return.
    flows: {
      scorp: { prior: out.net_profit.prior, baseline: out.net_profit.baseline },
      interest: flow(['interest_income']),
      dividends: flow(['ordinary_dividends']),
      qualifiedDividends: flow(['qualified_dividends']),
      stGain: flow(['portfolio_st_gain', 'passive_st_gain', 'st_gain_loan_repayment']),
      ltGain: flow(['portfolio_lt_gain', 'passive_lt_gain', 'lt_gain_loan_repayment']),
      ordinaryGain: flow(['nonpassive_1231', 'passive_1231', 'nonpassive_ordinary_gain',
                          'passive_ordinary_gain', 'ordinary_gain_loan_repayment']),
    },
  };
}

// Aggregate every K-1 on a return. A K-1 with no detail entered falls back to
// the summary figures typed on its row, so a simple one need not be expanded.
export function aggregateK1s(k1s = []) {
  const zero = () => ({ prior: 0, baseline: 0 });
  const totals = {
    scorp: zero(), interest: zero(), dividends: zero(), qualifiedDividends: zero(),
    stGain: zero(), ltGain: zero(), ordinaryGain: zero(),
  };
  const perK1 = [];
  for (const k1 of (Array.isArray(k1s) ? k1s : [])) {
    const hasDetail = k1 && k1.values && Object.keys(k1.values).length > 0;
    if (hasDetail) {
      const c = computeK1(k1.values);
      perK1.push({ name: k1.name || '', ein: k1.ein || '', hasDetail: true, computed: c });
      for (const key of Object.keys(totals)) {
        totals[key].prior = round(totals[key].prior + c.flows[key].prior);
        totals[key].baseline = round(totals[key].baseline + c.flows[key].baseline);
      }
    } else {
      const s = cols(k1);
      perK1.push({ name: k1?.name || '', ein: k1?.ein || '', hasDetail: false, summary: s });
      totals.scorp.prior = round(totals.scorp.prior + s.prior);
      totals.scorp.baseline = round(totals.scorp.baseline + s.baseline);
    }
  }
  return { totals, perK1 };
}
