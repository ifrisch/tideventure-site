// Estimated tax projection worksheet — structure and arithmetic.
//
// Deliberately split out of index.js: this is DATA about the shape of a tax
// projection, it will be edited every filing season, and keeping it separate
// means a yearly update is a review of one small file rather than a diff
// against the whole Worker.
//
// ── The one rule that matters here ──
// Every line declares how it gets its value, and only one of those kinds can
// ever be wrong about tax law:
//
//   input    the CPA types it. Cannot be wrong — it is testimony, not inference.
//   memo     the CPA types it, and it feeds NO total. State-only and breakdown
//            rows live here so they can be recorded without affecting federal math.
//   sum      adds up other lines. Pure arithmetic; correct in every tax year.
//   net      first line minus the rest. Pure arithmetic.
//   taxrule  REQUIRES KNOWLEDGE OF TAX LAW (brackets, floors, caps, phaseouts).
//            These are the only risky lines. Today every one of them is entered
//            by hand; each can later be switched to a computed value one at a
//            time, per line and per year, without touching anything else.
//
// A category whose detail rows do not provably sum to it is an `input`, not a
// `sum`. Interest and dividends are the live examples: in the reference
// worksheet their detail totals 42 and 1,394 against categories of 599 and
// 7,495, so inventing a formula there would silently produce wrong numbers.

export const FILING_STATUSES = [
  { key: 'single', label: 'Single' },
  { key: 'mfj', label: 'Married Filing Jointly' },
  { key: 'mfs', label: 'Married Filing Separately' },
  { key: 'hoh', label: 'Head of Household' },
];

export const isValidFilingStatus = (s) => FILING_STATUSES.some(f => f.key === s);

// Spouse rows are only meaningful on a joint return. On a separate return each
// spouse files their own worksheet, so the spouse column is hidden there too.
export const showsSpouse = (filingStatus) => filingStatus === 'mfj';

// Repeatable detail groups: entity-level rows the CPA adds as needed (each W-2
// employer, each K-1). Stored as arrays rather than fixed keys.
export const GROUPS = [
  { key: 'w2', label: 'W-2 employers', rowLabel: 'Employer', sumsInto: 'w2_wages', detailNote: 'W-2 Box 1' },
  { key: 'k1s', label: 'S corporation K-1s', rowLabel: 'Entity', sumsInto: 'scorp_income', detailNote: 'Schedule K-1 (1120S) net profit (loss)' },
];

// depth drives indentation only. `t` is the kind above. `of` lists the keys a
// sum/net is built from.
export const LINES = [
  // ── Income ──
  { k: 'w2_wages', l: 'W-2 Wages', t: 'group', group: 'w2', depth: 0 },
  { k: 'household_wages', l: 'Household employee wages not on W-2', t: 'input', depth: 1 },
  { k: 'tips_not_reported', l: 'Tips not reported on Form W-2', t: 'input', depth: 1 },
  { k: 'medicare_waiver', l: 'Medicare waiver payments', t: 'input', depth: 1 },
  { k: 'dependent_care_taxable', l: 'Taxable dependent care benefits', t: 'input', depth: 1 },
  { k: 'adoption_benefits', l: 'Adoption benefits not reported on Form W-2', t: 'input', depth: 1 },
  { k: 'wages_8919', l: 'Wages from Form 8919', t: 'input', depth: 1 },
  { k: 'other_earned_wage', l: 'Other earned wage income', t: 'input', depth: 1 },
  { k: 'combat_pay', l: 'Nontaxable combat pay', t: 'memo', depth: 1, note: 'Not included in total wages — excluded from income.' },
  { k: 'foreign_wages', l: 'Foreign wages', t: 'memo', depth: 1, note: 'Memo. Confirm treatment before relying on it.' },
  { k: 'total_wages', l: 'Total Wages', t: 'sum', depth: 0, bold: true,
    of: ['w2_wages', 'household_wages', 'tips_not_reported', 'medicare_waiver', 'dependent_care_taxable', 'adoption_benefits', 'wages_8919', 'other_earned_wage'] },

  { k: 'business_income', l: 'Business Income', t: 'input', depth: 0 },
  { k: 'rental_income', l: 'Rental Income', t: 'input', depth: 0 },
  { k: 'farm_income', l: 'Farm Income', t: 'input', depth: 0 },
  { k: 'partnership_income', l: 'Partnership Income', t: 'input', depth: 0 },
  { k: 'scorp_income', l: 'S Corporation Income', t: 'group', group: 'k1s', depth: 0 },
  { k: 'estate_trust_income', l: 'Estate / Trust Income', t: 'input', depth: 0 },

  // Capital gains. These DO tie out in the reference worksheet, so they compute.
  { k: 'st_gain', l: 'Short-term capital gain (loss)', t: 'input', depth: 1 },
  { k: 'st_gain_state', l: 'State short-term capital gain (loss)', t: 'memo', depth: 2 },
  { k: 'st_gain_passthrough', l: 'Short-term capital gain (loss) from passthrough', t: 'input', depth: 1 },
  { k: 'st_loss_carryover', l: 'Short-term capital loss carryover', t: 'input', depth: 1 },
  { k: 'net_st_gain', l: 'Net short-term capital gain (loss)', t: 'sum', depth: 1,
    of: ['st_gain', 'st_gain_passthrough', 'st_loss_carryover'] },
  { k: 'lt_gain', l: 'Long-term capital gain (loss)', t: 'input', depth: 1 },
  { k: 'lt_gain_state', l: 'State long-term capital gain (loss)', t: 'memo', depth: 2 },
  { k: 'lt_gain_passthrough', l: 'Long-term capital gain (loss) from passthrough', t: 'input', depth: 1 },
  { k: 'cap_gain_distributions', l: 'Capital gain distributions', t: 'input', depth: 1 },
  { k: 'lt_loss_carryover', l: 'Long-term capital loss carryover', t: 'input', depth: 1 },
  { k: 'sec1231_gain', l: 'Section 1231 capital gain', t: 'input', depth: 1 },
  { k: 'sec1231_gain_state', l: 'State Section 1231 capital gain', t: 'memo', depth: 2 },
  { k: 'gain_28pct', l: '28% long-term gain', t: 'memo', depth: 1, note: 'Rate bucket — already inside the long-term total. Not added again.' },
  { k: 'unrecaptured_1250', l: 'Unrecaptured Section 1250 gain', t: 'memo', depth: 1, note: 'Rate bucket — already inside the long-term total. Not added again.' },
  { k: 'net_lt_gain', l: 'Net long-term capital gain (loss)', t: 'sum', depth: 1,
    of: ['lt_gain', 'lt_gain_passthrough', 'cap_gain_distributions', 'lt_loss_carryover', 'sec1231_gain'] },
  { k: 'capital_gain_income', l: 'Capital Gain Income', t: 'sum', depth: 0, of: ['net_st_gain', 'net_lt_gain'] },

  { k: 'ordinary_gain_loss', l: 'Ordinary gain (loss)', t: 'input', depth: 1 },
  { k: 'other_gains_losses', l: 'Other Gains or Losses', t: 'sum', depth: 0, of: ['ordinary_gain_loss'] },

  // Interest / dividends: detail does NOT tie to the category, so the category
  // is entered directly and the detail rows are recorded as breakdown only.
  { k: 'interest_income', l: 'Interest Income', t: 'input', depth: 0,
    note: 'Entered directly. The rows below are a breakdown for reference and do not add up to this figure.' },
  { k: 'interest_income_detail', l: 'Interest income', t: 'memo', depth: 1 },
  { k: 'interest_k1', l: 'Interest income from Sch K-1', t: 'memo', depth: 1 },
  { k: 'us_govt_obligations', l: 'U.S. government obligations', t: 'memo', depth: 1 },
  { k: 'us_govt_obligations_k1', l: 'U.S. government obligations from Sch K-1', t: 'memo', depth: 1 },
  { k: 'muni_total', l: 'Total municipal bonds', t: 'memo', depth: 1 },
  { k: 'muni_instate', l: 'In-state municipal bonds', t: 'memo', depth: 1 },
  { k: 'muni_k1', l: 'Total municipal bonds from Sch K-1', t: 'memo', depth: 1 },
  { k: 'muni_instate_k1', l: 'In-state bonds from Sch K-1', t: 'memo', depth: 1 },

  { k: 'dividend_income', l: 'Dividend Income', t: 'input', depth: 0,
    note: 'Entered directly. Qualified dividends are a subset of ordinary, so the rows below are a breakdown, not addends.' },
  { k: 'qualified_dividends', l: 'Qualified dividends', t: 'memo', depth: 1 },
  { k: 'qualified_dividends_adj', l: 'Adjustments to qualified dividends', t: 'memo', depth: 1 },
  { k: 'ordinary_dividends', l: 'Ordinary dividends', t: 'memo', depth: 1 },
  { k: 'ordinary_dividends_adj', l: 'Adjustments to ordinary dividends', t: 'memo', depth: 1 },

  { k: 'pension_ira', l: 'Pension and IRA Distributions', t: 'input', depth: 0 },

  { k: 'ss_benefits_t', l: 'Taxpayer Social Security and railroad retirement benefits', t: 'input', depth: 1 },
  { k: 'ss_benefits_s', l: 'Spouse Social Security and railroad retirement benefits', t: 'input', depth: 1, spouse: true },
  { k: 'ss_income', l: 'Social Security and Railroad Retirement Income', t: 'taxrule', depth: 0,
    note: 'Taxable portion depends on provisional income. Enter the taxable amount.' },
  { k: 'ss_withholding_t', l: 'Taxpayer federal withholding (SS/RR)', t: 'memo', depth: 1 },
  { k: 'ss_withholding_s', l: 'Spouse federal withholding (SS/RR)', t: 'memo', depth: 1, spouse: true },

  // Other income
  { k: 'refunds_t', l: 'Taxpayer taxable refunds', t: 'input', depth: 1 },
  { k: 'refunds_s', l: 'Spouse taxable refunds', t: 'input', depth: 1, spouse: true },
  { k: 'alimony_t', l: 'Taxpayer alimony received', t: 'input', depth: 1 },
  { k: 'alimony_s', l: 'Spouse alimony received', t: 'input', depth: 1, spouse: true },
  { k: 'unemployment_t', l: 'Taxpayer unemployment compensation', t: 'input', depth: 1 },
  { k: 'unemployment_s', l: 'Spouse unemployment compensation', t: 'input', depth: 1, spouse: true },
  { k: 'gambling_t', l: 'Taxpayer gambling winnings', t: 'input', depth: 1 },
  { k: 'gambling_s', l: 'Spouse gambling winnings', t: 'input', depth: 1, spouse: true },
  { k: 'lottery_t', l: 'Taxpayer state lottery winnings', t: 'input', depth: 1 },
  { k: 'lottery_s', l: 'Spouse state lottery winnings', t: 'input', depth: 1, spouse: true },
  { k: 'education_dist_t', l: 'Taxpayer education distributions', t: 'input', depth: 1 },
  { k: 'education_dist_s', l: 'Spouse education distributions', t: 'input', depth: 1, spouse: true },
  { k: 'property_refund_t', l: 'Taxpayer property tax refunds', t: 'input', depth: 1 },
  { k: 'property_refund_s', l: 'Spouse property tax refunds', t: 'input', depth: 1, spouse: true },
  { k: 'other_se_t', l: 'Taxpayer other income subject to SE tax', t: 'input', depth: 1 },
  { k: 'other_se_s', l: 'Spouse other income subject to SE tax', t: 'input', depth: 1, spouse: true },
  { k: 'other_nonse_t', l: 'Taxpayer other income not subject to SE tax', t: 'input', depth: 1 },
  { k: 'other_nonse_s', l: 'Spouse other income not subject to SE tax', t: 'input', depth: 1, spouse: true },
  { k: 'excess_business_loss', l: 'Excess business loss adjustment', t: 'taxrule', depth: 1,
    note: 'Section 461(l) limitation — enter the adjustment.' },
  { k: 'other_income', l: 'Other Income', t: 'sum', depth: 0,
    of: ['refunds_t', 'refunds_s', 'alimony_t', 'alimony_s', 'unemployment_t', 'unemployment_s', 'gambling_t', 'gambling_s',
         'lottery_t', 'lottery_s', 'education_dist_t', 'education_dist_s', 'property_refund_t', 'property_refund_s',
         'other_se_t', 'other_se_s', 'other_nonse_t', 'other_nonse_s', 'excess_business_loss'] },

  { k: 'nol', l: 'Net Operating Loss', t: 'input', depth: 0 },

  { k: 'total_income', l: 'Total Income', t: 'sum', depth: 0, major: true,
    of: ['total_wages', 'business_income', 'rental_income', 'farm_income', 'partnership_income', 'scorp_income',
         'estate_trust_income', 'capital_gain_income', 'other_gains_losses', 'interest_income', 'dividend_income',
         'pension_ira', 'ss_income', 'other_income', 'nol'] },

  // ── Adjustments ──
  { k: 'hdr_retirement', l: 'Retirement', t: 'header', depth: 1 },
  { k: 'ira_t', l: 'Taxpayer IRA contribution', t: 'input', depth: 2 },
  { k: 'ira_s', l: 'Spouse IRA contribution', t: 'input', depth: 2, spouse: true },
  { k: 'qual_plan_t', l: 'Taxpayer qualified plan / profit sharing', t: 'input', depth: 2 },
  { k: 'qual_plan_s', l: 'Spouse qualified plan / profit sharing', t: 'input', depth: 2, spouse: true },
  { k: 'solo401k_t', l: 'Taxpayer Solo 401(k) contribution', t: 'input', depth: 2 },
  { k: 'solo401k_s', l: 'Spouse Solo 401(k) contribution', t: 'input', depth: 2, spouse: true },
  { k: 'sep_t', l: 'Taxpayer SEP IRA contribution', t: 'input', depth: 2 },
  { k: 'sep_s', l: 'Spouse SEP IRA contribution', t: 'input', depth: 2, spouse: true },
  { k: 'money_purchase_t', l: 'Taxpayer money purchase plan', t: 'input', depth: 2 },
  { k: 'money_purchase_s', l: 'Spouse money purchase plan', t: 'input', depth: 2, spouse: true },
  { k: 'simple_t', l: 'Taxpayer SIMPLE contribution', t: 'input', depth: 2 },
  { k: 'simple_match_t', l: 'Taxpayer SIMPLE employer matching contribution', t: 'taxrule', depth: 2, note: 'Subject to statutory matching limits.' },
  { k: 'simple_s', l: 'Spouse SIMPLE contribution', t: 'input', depth: 2, spouse: true },
  { k: 'simple_match_s', l: 'Spouse SIMPLE employer matching contribution', t: 'taxrule', depth: 2, spouse: true, note: 'Subject to statutory matching limits.' },
  { k: 'hdr_healthcare', l: 'Healthcare', t: 'header', depth: 1 },
  { k: 'hsa_t', l: 'Taxpayer HSA contribution', t: 'input', depth: 2 },
  { k: 'hsa_s', l: 'Spouse HSA contribution', t: 'input', depth: 2, spouse: true },
  { k: 'hdr_education', l: 'Education', t: 'header', depth: 1 },
  { k: 'educator_t', l: 'Taxpayer educator expenses', t: 'input', depth: 2 },
  { k: 'educator_allowed_t', l: 'Taxpayer educator expenses allowed', t: 'taxrule', depth: 2, note: 'Capped by statute.' },
  { k: 'educator_s', l: 'Spouse educator expenses', t: 'input', depth: 2, spouse: true },
  { k: 'educator_allowed_s', l: 'Spouse educator expenses allowed', t: 'taxrule', depth: 2, spouse: true, note: 'Capped by statute.' },
  { k: 'hdr_business_adj', l: 'Business', t: 'header', depth: 1 },
  { k: 'emp_bus_exp_t', l: 'Taxpayer employee business expenses', t: 'input', depth: 2 },
  { k: 'emp_bus_exp_s', l: 'Spouse employee business expenses', t: 'input', depth: 2, spouse: true },
  { k: 'ltc_premium_t', l: 'Taxpayer LTC premium business expenses', t: 'input', depth: 2 },
  { k: 'ltc_premium_s', l: 'Spouse LTC premium business expenses', t: 'input', depth: 2, spouse: true },
  { k: 'se_health_t', l: 'Taxpayer SE health insurance deduction', t: 'input', depth: 2 },
  { k: 'se_health_s', l: 'Spouse SE health insurance deduction', t: 'input', depth: 2, spouse: true },
  { k: 'other_adj_t', l: 'Taxpayer other adjustments', t: 'input', depth: 2 },
  { k: 'other_adj_s', l: 'Spouse other adjustments', t: 'input', depth: 2, spouse: true },
  { k: 'half_se_tax', l: 'One half SE tax deduction', t: 'taxrule', depth: 2, note: 'Derived from self-employment tax.' },
  { k: 'adjustments_to_income', l: 'Adjustments to Income', t: 'sum', depth: 0,
    of: ['ira_t', 'ira_s', 'qual_plan_t', 'qual_plan_s', 'solo401k_t', 'solo401k_s', 'sep_t', 'sep_s',
         'money_purchase_t', 'money_purchase_s', 'simple_t', 'simple_match_t', 'simple_s', 'simple_match_s',
         'hsa_t', 'hsa_s', 'educator_allowed_t', 'educator_allowed_s', 'emp_bus_exp_t', 'emp_bus_exp_s',
         'ltc_premium_t', 'ltc_premium_s', 'se_health_t', 'se_health_s', 'other_adj_t', 'other_adj_s', 'half_se_tax'] },

  { k: 'agi', l: 'Adjusted Gross Income (AGI)', t: 'net', depth: 0, major: true, of: ['total_income', 'adjustments_to_income'] },

  // ── Deductions ──
  { k: 'mortgage_1098', l: 'Mortgage interest on Form 1098', t: 'input', depth: 1 },
  { k: 'mortgage_no_1098', l: 'Mortgage interest not on 1098', t: 'input', depth: 1 },
  { k: 'home_office_mortgage', l: 'Home office nonbusiness mortgage interest', t: 'input', depth: 1 },
  { k: 'mortgage_credit_adj', l: 'Mortgage interest credit adjustment', t: 'input', depth: 1 },
  { k: 'mortgage_excess_limit', l: 'Home mortgage interest subject to excess mortgage limitations', t: 'taxrule', depth: 1, note: 'Acquisition-debt limitation.' },
  { k: 'points', l: 'Points', t: 'input', depth: 1 },
  { k: 'real_estate_taxes', l: 'Real estate taxes', t: 'input', depth: 1 },
  { k: 'misc_state_local_tax', l: 'Miscellaneous state and local tax payments', t: 'input', depth: 1 },
  { k: 'state_local_tax', l: 'State and local tax payments', t: 'input', depth: 1 },
  { k: 'allowed_taxes', l: 'Allowed taxes', t: 'taxrule', depth: 1, note: 'Subject to the SALT cap.' },
  { k: 'medical_adj', l: 'Medical expenses adjustment', t: 'input', depth: 1 },
  { k: 'allowed_medical', l: 'Allowed medical expenses', t: 'taxrule', depth: 1, note: 'Reduced by a percentage-of-AGI floor.' },
  { k: 'charitable_cash', l: 'Charitable cash contributions', t: 'input', depth: 1 },
  { k: 'charitable_noncash', l: 'Charitable noncash contributions', t: 'input', depth: 1 },
  { k: 'charitable_50_adj', l: '50% limit noncash contributions adjustment', t: 'input', depth: 1 },
  { k: 'charitable_30_adj', l: '30% limit noncash contributions adjustment', t: 'input', depth: 1 },
  { k: 'charitable_30_cg_adj', l: '30% limit capital gain contributions adjustment', t: 'input', depth: 1 },
  { k: 'charitable_20_cg_adj', l: '20% limit capital gain contributions adjustment', t: 'input', depth: 1 },
  { k: 'allowed_charitable', l: 'Allowed charitable contributions', t: 'taxrule', depth: 1, note: 'Subject to AGI percentage limits.' },
  { k: 'casualty_theft', l: 'Casualty and theft losses', t: 'input', depth: 1 },
  { k: 'other_misc_deductions', l: 'Other miscellaneous deductions', t: 'input', depth: 1 },
  { k: 'standard_deduction', l: 'Standard deduction', t: 'taxrule', depth: 1, note: 'Varies by filing status and year.' },
  { k: 'senior_deduction', l: 'Senior deduction', t: 'taxrule', depth: 1, note: 'Age-based; varies by filing status and year.' },
  { k: 'other_deduction', l: 'Other deduction', t: 'input', depth: 1 },
  { k: 'deductions', l: 'Standard or Itemized Deductions', t: 'taxrule', depth: 0, major: true,
    note: 'Larger of itemized or standard, plus senior and other deductions. Enter the figure you are using.' },

  { k: 'qbi_deduction', l: 'Qualified Business Income Deduction', t: 'taxrule', depth: 0, note: 'Section 199A — thresholds, wage limits and SSTB phaseouts.' },

  { k: 'taxable_income', l: 'Taxable Income', t: 'net', depth: 0, major: true, of: ['agi', 'deductions', 'qbi_deduction'] },

  // ── Tax ──
  { k: 'federal_tax', l: 'Federal tax', t: 'taxrule', depth: 1, note: 'Bracket and capital-gain rate computation.' },
  { k: 'amt', l: 'Alternative minimum tax', t: 'taxrule', depth: 1 },
  { k: 'other_taxes_sch2', l: 'Other taxes', t: 'input', depth: 1 },
  { k: 'federal_tax_before_credits', l: 'Federal Tax Before Credits', t: 'sum', depth: 0, major: true,
    of: ['federal_tax', 'amt', 'other_taxes_sch2'] },

  { k: 'child_tax_credit', l: 'Child tax credit or credit for other dependents', t: 'taxrule', depth: 1, note: 'Income phaseout.' },
  { k: 'foreign_tax_credit', l: 'Foreign tax credit override', t: 'input', depth: 1 },
  { k: 'residential_energy', l: 'Residential energy costs', t: 'input', depth: 1 },
  { k: 'allowed_residential_energy', l: 'Allowed residential energy credit', t: 'taxrule', depth: 1 },
  { k: 'education_credit', l: 'Education credit', t: 'input', depth: 1 },
  { k: 'adoption_credit', l: 'Adoption credit', t: 'input', depth: 1 },
  { k: 'minimum_tax_credit', l: 'Minimum tax credit', t: 'input', depth: 1 },
  { k: 'dependent_care_credit', l: 'Child and dependent care credit', t: 'input', depth: 1 },
  { k: 'allowed_dependent_care', l: 'Allowed child and dependent care credit', t: 'taxrule', depth: 1 },
  { k: 'general_business_credit', l: 'General business credit', t: 'input', depth: 1 },
  { k: 'other_credits', l: 'Other credits', t: 'input', depth: 1 },
  { k: 'nonrefundable_credit_adj', l: 'Nonrefundable credit adjustment', t: 'input', depth: 1 },
  { k: 'credits_nonrefundable', l: 'Credits (non-refundable)', t: 'sum', depth: 0, major: true,
    of: ['child_tax_credit', 'foreign_tax_credit', 'allowed_residential_energy', 'education_credit', 'adoption_credit',
         'minimum_tax_credit', 'allowed_dependent_care', 'general_business_credit', 'other_credits', 'nonrefundable_credit_adj'] },

  { k: 'se_tax', l: 'Self-employment tax', t: 'taxrule', depth: 1 },
  { k: 'niit', l: 'Net investment income tax', t: 'taxrule', depth: 1, note: '3.8% above a filing-status threshold.' },
  { k: 'additional_ss_medicare', l: 'Additional Social Security and Medicare tax', t: 'taxrule', depth: 1 },
  { k: 'ira_penalty_tax', l: 'Additional tax on IRAs or other tax-favored accounts', t: 'input', depth: 1 },
  { k: 'household_employment_tax', l: 'Household employment taxes', t: 'input', depth: 1 },
  { k: 'homebuyer_repayment', l: 'Repayment of first-time homebuyer credit', t: 'input', depth: 1 },
  { k: 'additional_medicare', l: 'Additional Medicare tax', t: 'taxrule', depth: 1, note: '0.9% above a filing-status threshold.' },
  { k: 'other_taxes_schedule2', l: 'Other taxes from Schedule 2', t: 'input', depth: 1 },
  { k: 'other_taxes', l: 'Other Taxes', t: 'sum', depth: 0, major: true,
    of: ['se_tax', 'niit', 'additional_ss_medicare', 'ira_penalty_tax', 'household_employment_tax',
         'homebuyer_repayment', 'additional_medicare', 'other_taxes_schedule2'] },

  // ── Payments ──
  { k: 'overpayment_applied', l: 'Overpayment applied from prior year', t: 'input', depth: 1 },
  { k: 'q1_payment', l: 'Q1 estimated tax payment', t: 'input', depth: 1 },
  { k: 'q2_payment', l: 'Q2 estimated tax payment', t: 'input', depth: 1 },
  { k: 'q3_payment', l: 'Q3 estimated tax payment', t: 'input', depth: 1 },
  { k: 'q4_payment', l: 'Q4 estimated tax payment', t: 'input', depth: 1 },
  { k: 'additional_payment_1', l: 'Additional tax payment 1', t: 'input', depth: 1 },
  { k: 'additional_payment_2', l: 'Additional tax payment 2', t: 'input', depth: 1 },
  { k: 'additional_payment_3', l: 'Additional tax payment 3', t: 'input', depth: 1 },
  { k: 'additional_payment_4', l: 'Additional tax payment 4', t: 'input', depth: 1 },
  { k: 'extension_payment', l: 'Tax paid with extension', t: 'input', depth: 1 },
  { k: 'withholding_adj', l: 'Withholding adjustment', t: 'input', depth: 1 },
  { k: 'total_withholding', l: 'Total withholding', t: 'input', depth: 1 },
  { k: 'payments_adj', l: 'Payments adjustment', t: 'input', depth: 1 },
  { k: 'payments', l: 'Payments', t: 'sum', depth: 0, major: true,
    of: ['overpayment_applied', 'q1_payment', 'q2_payment', 'q3_payment', 'q4_payment',
         'additional_payment_1', 'additional_payment_2', 'additional_payment_3', 'additional_payment_4',
         'extension_payment', 'withholding_adj', 'total_withholding', 'payments_adj'] },

  { k: 'refundable_ctc', l: 'Refundable child tax credit', t: 'taxrule', depth: 1 },
  { k: 'refundable_dependent_care', l: 'Refundable child and dependent care credit', t: 'taxrule', depth: 1 },
  { k: 'refundable_education', l: 'Refundable education credits', t: 'taxrule', depth: 1 },
  { k: 'eitc', l: 'Earned income tax credit', t: 'taxrule', depth: 1 },
  { k: 'other_refundable', l: 'Other refundable credits and payments', t: 'input', depth: 1 },
  { k: 'net_premium_tax_credit', l: 'Net premium tax credit', t: 'taxrule', depth: 1 },
  { k: 'refundable_credits', l: 'Refundable Credits', t: 'sum', depth: 0, major: true,
    of: ['refundable_ctc', 'refundable_dependent_care', 'refundable_education', 'eitc', 'other_refundable', 'net_premium_tax_credit'] },

  { k: 'underpayment_penalty', l: 'Underpayment penalty', t: 'taxrule', depth: 0, note: 'Form 2210.' },
];

export const LINE_BY_KEY = Object.fromEntries(LINES.map(l => [l.k, l]));

// Lines whose value requires knowing tax law — the only ones that can go stale.
export const TAXRULE_KEYS = LINES.filter(l => l.t === 'taxrule').map(l => l.k);

const n = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const round = (x) => Math.round(x * 100) / 100;

// The two columns anyone actually types are PRIOR (what last year's return
// said) and BASELINE (what the current year looks like right now). DIFFERENCE
// is derived from them, never entered — asking for a delta would mean doing the
// subtraction by hand, and the point of the baseline column is that it starts as
// a roll-over of prior and gets corrected as real figures arrive through the
// year. So both real columns are computed independently and diff falls out.
//
// `values` is { lineKey: {prior, baseline} }, `groups` is
// { groupKey: [{name, prior, baseline}] }. Records written before the baseline
// column existed stored {prior, diff}; those are read forward here rather than
// migrated, so an old worksheet opens with the figures it was saved with.
const enteredColumns = (entered = {}) => {
  const prior = round(n(entered.prior));
  const baseline = entered.baseline != null && entered.baseline !== ''
    ? round(n(entered.baseline))
    : round(prior + n(entered.diff));
  return { prior, baseline };
};

export function computeWorksheet(values = {}, groups = {}, filingStatus = 'single') {
  const out = {};
  const col = ['prior', 'baseline'];

  const groupTotals = {};
  for (const g of GROUPS) {
    const rows = Array.isArray(groups[g.key]) ? groups[g.key] : [];
    const cols = rows.map(enteredColumns);
    groupTotals[g.sumsInto] = {
      prior: round(cols.reduce((s, r) => s + r.prior, 0)),
      baseline: round(cols.reduce((s, r) => s + r.baseline, 0)),
    };
  }

  for (const line of LINES) {
    if (line.t === 'header') continue;
    const v = { prior: 0, baseline: 0 };
    if (line.t === 'group') {
      const gt = groupTotals[line.k] || { prior: 0, baseline: 0 };
      v.prior = gt.prior; v.baseline = gt.baseline;
    } else if (line.t === 'sum') {
      for (const c of col) v[c] = round((line.of || []).reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
    } else if (line.t === 'net') {
      for (const c of col) {
        const [first, ...rest] = line.of || [];
        v[c] = round((out[first] ? out[first][c] : 0) - rest.reduce((s, k) => s + (out[k] ? out[k][c] : 0), 0));
      }
    } else {
      const e = enteredColumns(values[line.k]);
      v.prior = e.prior; v.baseline = e.baseline;
    }
    v.diff = round(v.baseline - v.prior);
    out[line.k] = v;
  }

  // Totals and the numbers the whole worksheet exists to produce.
  const at = (k, c) => (out[k] ? out[k][c] : 0);
  const totals = {};
  for (const c of ['prior', 'baseline']) {
    totals[c] = {
      totalTax: round(at('federal_tax_before_credits', c) - at('credits_nonrefundable', c) + at('other_taxes', c)),
    };
    totals[c].balanceDue = round(
      totals[c].totalTax - at('payments', c) - at('refundable_credits', c) + at('underpayment_penalty', c)
    );
  }
  // Difference is derived from the two real columns, like every other row.
  totals.diff = {
    totalTax: round(totals.baseline.totalTax - totals.prior.totalTax),
    balanceDue: round(totals.baseline.balanceDue - totals.prior.balanceDue),
  };

  // Projected quarterly instalment: what is still needed after withholding and
  // any prior-year overpayment, split evenly across the four due dates.
  const needed = round(totals.baseline.totalTax - at('total_withholding', 'baseline') - at('overpayment_applied', 'baseline'));
  const quarterly = round(Math.max(0, needed) / 4);

  return {
    lines: out,
    totals,
    projected: { annualNeeded: Math.max(0, needed), quarterly },
    safeHarbor: safeHarbor(totals.prior.totalTax, at('agi', 'prior'), filingStatus),
  };
}

// Prior-year safe harbor — the minimum pay-in that avoids an underpayment
// penalty regardless of how the current-year projection turns out. Kept separate
// and fully explained because it is the one figure that stays reliable even when
// the projection above is uncertain. VERIFY the threshold and percentages against
// current authority before relying on them; they are stated here, not hidden.
export const SAFE_HARBOR_RULE = {
  basePercent: 100,
  highIncomePercent: 110,
  agiThreshold: { single: 150000, mfj: 150000, hoh: 150000, mfs: 75000 },
};

export function safeHarbor(priorYearTotalTax, priorYearAgi, filingStatus = 'single') {
  const threshold = SAFE_HARBOR_RULE.agiThreshold[filingStatus] ?? 150000;
  const high = n(priorYearAgi) > threshold;
  const pct = high ? SAFE_HARBOR_RULE.highIncomePercent : SAFE_HARBOR_RULE.basePercent;
  const annual = round(n(priorYearTotalTax) * (pct / 100));
  return {
    percent: pct,
    threshold,
    priorYearAgi: round(n(priorYearAgi)),
    priorYearTotalTax: round(n(priorYearTotalTax)),
    annual,
    quarterly: round(annual / 4),
    basis: `${pct}% of prior-year total tax, because prior-year AGI of ${round(n(priorYearAgi)).toLocaleString()} ${high ? 'exceeds' : 'does not exceed'} the ${threshold.toLocaleString()} threshold for this filing status.`,
  };
}
