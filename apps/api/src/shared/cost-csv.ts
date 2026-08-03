// format=csv on the cost list routes runs the same filtered query as the
// JSON response, then serializes it here instead of returning a JSON body.
// Capped so a finance export can't walk an unbounded account: the cap is
// reported in x-kortix-row-cap so the caller can warn instead of silently
// truncating.
export const CSV_ROW_CAP = 10_000;

const NEEDS_QUOTING = /["\r\n,]/;
// A leading =, +, - or @ makes Excel/Sheets/Numbers evaluate the cell as a
// formula. project_name and owner are free text the account's own users
// control, so a name like `=HYPERLINK(...)` or `=cmd|...!A1` opened by
// whoever pulls this cost export is a CSV/formula injection vector, not a
// hypothetical. Prefixing with an apostrophe keeps the cell text in every
// major spreadsheet application without changing what a human reads.
//
// `\s*` before the trigger character, not just `^[=+\-@]`: several
// spreadsheet CSV importers strip leading whitespace before checking for a
// formula prefix, so " =cmd|...!A0" (leading space) is exactly as live an
// injection as "=cmd|...!A0" — anchoring on literal string start alone would
// let that variant through unneutralised and unquoted. `\s` already covers
// tab, CR, LF, vertical tab, form feed and non-breaking space (the realistic
// bypass variants); no need to hand-roll a wider character class.
const FORMULA_PREFIX = /^\s*[=+\-@]/;

function encodeField(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  // A number can never BE a formula — only a string can. -1.5 rendered via
  // String() starts with "-", which looks like a formula trigger but is
  // legitimate signed money; neutralising it would corrupt the export's
  // numeric columns into apostrophe-prefixed text a finance user can no
  // longer sum in Excel. Money fields are typed `number` end to end (no
  // caller passes a numeric value as a string), so this exemption never
  // reopens the injection surface — only genuine string values run the
  // formula check below.
  if (typeof value === 'number') {
    const text = String(value);
    return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  const neutralised = FORMULA_PREFIX.test(value);
  // The apostrophe is prepended to the ORIGINAL value, leading whitespace
  // included — stripping that whitespace here would let the cell round-trip
  // back to a formula-looking string once re-opened and re-saved elsewhere.
  const text = neutralised ? `'${value}` : value;
  // A neutralised value is always quoted, even if the apostrophe alone would
  // already stop spreadsheet software from evaluating it as a formula —
  // quoting removes any doubt that the leading apostrophe (and any leading
  // whitespace before it) survives as inert text rather than being
  // reinterpreted.
  if (!neutralised && !NEEDS_QUOTING.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

// Pure and synchronous on purpose: every row is already in memory (the
// caller queried at most CSV_ROW_CAP rows), so there is nothing to stream
// and nothing here needs a database or the request context.
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.map(encodeField).join(',')];
  for (const row of rows) lines.push(row.map(encodeField).join(','));
  return lines.join('\r\n');
}
