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

// ── Schedule K-1 (Form 1120S) ──
//
// A K-1 is a GRID, not a column of lines. Part III runs two columns of numbered
// boxes side by side, so reassembling by height alone produces rows like
// "1 Ordinary business income 107,924 13 Credits" — and taking the last number
// on such a row, which is right for a 1040, would read a credit as business
// income. So boxes are extracted individually: find each "<box> <label>
// <amount>" run wherever it appears on a line, and take the amount that belongs
// to that box rather than the last one on the row.
const K1_BOXES = [
  { box: '1',  key: 'ordinary_income',       label: 'Ordinary business income (loss)' },
  { box: '2',  key: 'rental_real_estate',    label: 'Net rental real estate income (loss)' },
  { box: '3',  key: 'other_rental',          label: 'Other net rental income (loss)' },
  { box: '4',  key: 'interest_income',       label: 'Interest income' },
  { box: '5a', key: 'ordinary_dividends',    label: 'Ordinary dividends' },
  { box: '5b', key: 'qualified_dividends',   label: 'Qualified dividends' },
  { box: '7',  key: 'portfolio_st_gain',     label: 'Net short-term capital gain (loss)' },
  { box: '8a', key: 'portfolio_lt_gain',     label: 'Net long-term capital gain (loss)' },
  { box: '8b', key: 'portfolio_lt_28',       label: 'Collectibles (28%) gain (loss)' },
  { box: '8c', key: 'unrecaptured_1250',     label: 'Unrecaptured section 1250 gain' },
  { box: '9',  key: 'nonpassive_1231',       label: 'Net section 1231 gain (loss)' },
  { box: '10', key: 'nonpassive_ordinary_gain', label: 'Other income (loss)' },
  { box: '11', key: 'sec179_deduction',      label: 'Section 179 deduction' },
];
const K1_BOX_BY_NUMBER = Object.fromEntries(K1_BOXES.map(b => [b.box, b]));

// EVERY box on the form, including ones we do not import. They are needed as
// segment boundaries: without '13' in this set, the row
// "1 Ordinary business income (loss) 107,924 13 Credits" runs to the end of the
// line and the last number found is 13. A box we ignore still has to stop the
// box before it.
const K1_ALL_BOXES = new Set(['1','2','3','4','5a','5b','6','7','8a','8b','8c','9','10',
                              '11','12','13','14','15','16','17']);

// A page is a K-1 only if it says so. Without this, box-shaped text anywhere in
// a long return would be read as shareholder figures.
function looksLikeK1(lines) {
  const text = lines.join(' ').toLowerCase();
  return text.includes('schedule k-1') &&
         (text.includes('1120-s') || text.includes('1120s') || text.includes('shareholder'));
}

function toAmount(raw) {
  if (!raw) return null;
  const negative = raw.startsWith('(') || raw.startsWith('-');
  const n = parseFloat(raw.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function matchScheduleK1(pages) {
  const k1s = [];
  for (const { page, lines } of pages) {
    if (!looksLikeK1(lines)) continue;
    const values = {};
    const evidence = [];
    let ein = null, ownership = null;

    for (const line of lines) {
      // Split the row at each box number, then take the LAST number inside that
      // box's own segment.
      //
      // The obvious approach — box number, then wording, then the first number —
      // reads the digits out of the wording itself: "Net section 1231 gain" gave
      // 1231, and "Section 179 deduction" gave 179, quietly turning a 70,740 loss
      // into a 107,745 profit. Anchoring on the box and taking the last number
      // before the next box is immune to digits inside a label, and still keeps
      // the two columns of Part III apart.
      const tokens = line.split(/\s+/);
      const anchors = [];
      tokens.forEach((t, i) => {
        if (!K1_ALL_BOXES.has(t)) return;
        // A box number is followed by its wording. Requiring that stops an
        // amount that happens to equal a box number from splitting the row.
        const next = tokens[i + 1];
        if (next && /^[A-Za-z]/.test(next)) anchors.push(i);
      });
      for (let a = 0; a < anchors.length; a++) {
        const box = tokens[anchors[a]];
        const spec = K1_BOX_BY_NUMBER[box];
        if (!spec || values[spec.key] !== undefined) continue;
        const segment = tokens.slice(anchors[a] + 1, a + 1 < anchors.length ? anchors[a + 1] : tokens.length).join(' ');
        // A box with no wording after it is a stray digit, not a labelled box.
        if (!/[A-Za-z]/.test(segment)) continue;
        const nums = segment.match(/\(\s*[\d,]+(?:\.\d{2})?\s*\)|-?[\d,]+(?:\.\d{2})?/g);
        if (!nums) continue;
        const amount = toAmount(nums[nums.length - 1].replace(/\s/g, ''));
        if (amount === null) continue;
        values[spec.key] = amount;
        evidence.push({ box, key: spec.key, label: spec.label, amount, source: line.slice(0, 140) });
      }

      const einM = line.match(/\b(\d{2}-\d{7})\b/);
      if (einM && !ein) ein = einM[1];
      const pctM = line.match(/percentage of (?:stock )?ownership[^\d]{0,30}(\d{1,3}(?:\.\d+)?)\s*%/i);
      if (pctM && ownership === null) ownership = parseFloat(pctM[1]);
    }

    if (Object.keys(values).length) k1s.push({ page, ein, ownership, values, evidence });
  }
  const missed = K1_BOXES.filter(b => !k1s.some(k => k.values[b.key] !== undefined))
                         .map(b => ({ box: b.box, label: b.label }));
  return { k1s, missed };
}
