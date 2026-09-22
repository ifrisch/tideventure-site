// Read a prior-year Form 1040 and pull its figures into the worksheet's
// prior-year column.
//
// This runs ENTIRELY IN THE BROWSER. The admin document endpoint returns the
// decrypted PDF to an authenticated admin, pdf.js parses it here, and the
// extracted numbers stay on this machine until they are saved as part of the
// worksheet. The return itself is never posted anywhere, and nothing about its
// contents leaves the page.
//
// Nothing is written automatically. Extraction proposes values; the CPA reviews
// every one against the return on screen and chooses what to accept. A parser
// that silently mis-reads line 11 is worse than no parser at all, so the review
// step is the feature, not friction around it.

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.mjs';

// Rebuild visual lines from positioned text runs. A form is a layout, not a
// paragraph: the label and its amount are separate runs at the same height, so
// grouping by y is what turns "1z" and "90,040" back into one readable row.
function itemsToLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    // 2pt tolerance: runs on one line are rarely pixel-identical.
    let bucket = null;
    for (const key of rows.keys()) { if (Math.abs(key - y) <= 2) { bucket = key; break; } }
    if (bucket === null) { bucket = y; rows.set(bucket, []); }
    rows.get(bucket).push({ x: it.transform[4], str: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, runs]) => runs.sort((a, b) => a.x - b.x).map(r => r.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export async function extractLines(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push({ page: p, lines: itemsToLines(content.items) });
  }
  return pages;
}

// Amounts sit at the right-hand end of a form line. Parentheses mean negative.
function lastAmount(line) {
  const matches = [...line.matchAll(/\(?\$?-?[\d,]+(?:\.\d{2})?\)?/g)]
    .map(m => m[0])
    .filter(t => /\d/.test(t) && t.replace(/\D/g, '').length >= 1);
  if (!matches.length) return null;
  const raw = matches[matches.length - 1];
  const negative = raw.startsWith('(') || raw.startsWith('-');
  const n = parseFloat(raw.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Form 1040 lines mapped onto worksheet keys.
//
// Matched on the printed line number AND wording, because either alone is
// unreliable: line numbers repeat across schedules, and wording shifts between
// tax years. Anything not matched here stays blank rather than being guessed —
// the K-1-driven lines in particular cannot come from a 1040 at all, since the
// form shows only the combined figure.
const FORM_1040 = [
  { key: 'w2_group',            worksheet: 'total_wages',        re: /\b1z\b.*total amount|wages.*salaries.*tips/i,          label: 'Wages (1z)' },
  { key: 'interest_income_own', worksheet: 'interest_income',    re: /\b2b\b.*taxable interest|taxable interest/i,            label: 'Taxable interest (2b)' },
  { key: 'ordinary_dividends',  worksheet: 'dividend_income',    re: /\b3b\b.*ordinary dividends|ordinary dividends/i,        label: 'Ordinary dividends (3b)' },
  { key: 'qualified_dividends', worksheet: 'qualified_dividends', re: /\b3a\b.*qualified dividends|qualified dividends/i,     label: 'Qualified dividends (3a)' },
  { key: 'pension_ira',         worksheet: 'pension_ira',        re: /\b(4b|5b)\b.*taxable amount|pensions and annuities/i,   label: 'IRA / pension taxable (4b, 5b)' },
  { key: 'ss_income',           worksheet: 'ss_income',          re: /\b6b\b.*taxable amount|social security benefits/i,      label: 'Taxable Social Security (6b)' },
  { key: 'capital_gain_1040',   worksheet: 'capital_gain_income', re: /\b7\b.*capital gain|capital gain or \(?loss\)?/i,    label: 'Capital gain or loss (7)' },
  { key: 'sched1_income',       worksheet: 'other_income',       re: /\b8\b.*additional income from schedule 1|additional income from schedule 1/i, label: 'Additional income, Sch 1 (8)' },
  { key: 'total_income',        worksheet: 'total_income',       re: /\b9\b.*total income|^total income/i,                    label: 'Total income (9)' },
  { key: 'adjustments_to_income', worksheet: 'adjustments_to_income', re: /\b10\b.*adjustments to income|adjustments to income/i, label: 'Adjustments to income (10)' },
  { key: 'agi',                 worksheet: 'agi',                re: /\b11\b.*adjusted gross income|adjusted gross income/i,  label: 'Adjusted gross income (11)' },
  { key: 'deductions',          worksheet: 'deductions',         re: /\b12\b.*standard deduction|itemized deductions or/i,    label: 'Standard or itemized deduction (12)' },
  { key: 'qbi_deduction',       worksheet: 'qbi_deduction',      re: /\b13\b.*qualified business income|qualified business income deduction/i, label: 'QBI deduction (13)' },
  { key: 'taxable_income',      worksheet: 'taxable_income',     re: /\b15\b.*taxable income|^taxable income/i,               label: 'Taxable income (15)' },
  { key: 'federal_tax',         worksheet: 'federal_tax',        re: /\b16\b.*tax \(see|^tax\b(?!able)/i,                   label: 'Tax (16)' },
  { key: 'credits_nonrefundable', worksheet: 'credits_nonrefundable', re: /\b21\b.*add lines 19 and 20|total credits/i,       label: 'Nonrefundable credits (21)' },
  { key: 'other_taxes',         worksheet: 'other_taxes',        re: /\b23\b.*other taxes.*schedule 2|other taxes, including/i, label: 'Other taxes (23)' },
  { key: 'total_tax_1040',      worksheet: null,                 re: /\b24\b.*total tax|this is your total tax/i,             label: 'Total tax (24)' },
  { key: 'total_withholding',   worksheet: 'total_withholding',  re: /\b25d\b|federal income tax withheld/i,                  label: 'Total withholding (25d)' },
  { key: 'estimated_payments',  worksheet: null,                 re: /\b26\b.*estimated tax payments|estimated tax payments/i, label: 'Estimated tax payments (26)' },
  { key: 'payments_total_1040', worksheet: 'payments',           re: /\b33\b.*total payments|these are your total payments/i,  label: 'Total payments (33)' },
];

// Keys that are informational only: the worksheet computes them from their
// parts, so importing them would overwrite a calculated figure with the form's
// rounded one and hide any disagreement.
export const READ_ONLY_KEYS = new Set([
  'total_income', 'agi', 'taxable_income', 'capital_gain_1040', 'total_tax_1040', 'payments_total_1040', 'w2_group',
]);

export function matchForm1040(pages) {
  const found = [];
  const seen = new Set();
  for (const { page, lines } of pages) {
    for (const line of lines) {
      for (const rule of FORM_1040) {
        if (seen.has(rule.key)) continue;
        if (!rule.re.test(line)) continue;
        const amount = lastAmount(line);
        if (amount === null) continue;
        seen.add(rule.key);
        found.push({ key: rule.key, worksheet: rule.worksheet, label: rule.label, amount, page,
                     source: line.slice(0, 160), appliesToWorksheet: !READ_ONLY_KEYS.has(rule.key) });
      }
    }
  }
  const missed = FORM_1040.filter(r => !seen.has(r.key)).map(r => ({ key: r.key, label: r.label }));
  return { found, missed };
}

// Every digit replaced, so a line can be shared to fix a pattern without
// carrying the figure on it. The wording is what a pattern matches on; the
// amount is never what needs to be seen to repair one.
export function maskAmounts(line) {
  return line.replace(/\d/g, '#');
}
