/** RFC 4180 CSV: a field with a comma, quote or newline is quoted, quotes doubled. Formula prefixes are neutralized. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (v: string | number) => {
    let s = String(v);
    // A spreadsheet runs a cell that starts with = + - @ as a formula (CSV injection).
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Hand the browser a CSV file to save. */
export function downloadCsv(filename: string, rows: ReadonlyArray<ReadonlyArray<string | number>>) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
