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
const FORMULA_PREFIX = /^[=+\-@]/;

function encodeField(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const neutralised = FORMULA_PREFIX.test(raw);
  const text = neutralised ? `'${raw}` : raw;
  // A neutralised value is always quoted, even if the apostrophe alone would
  // already stop spreadsheet software from evaluating it as a formula —
  // quoting removes any doubt that the leading apostrophe survives as inert
  // text rather than being reinterpreted.
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
