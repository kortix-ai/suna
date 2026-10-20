// How a review cell reads as text: in the grid, the cell panel and the CSV export.

export type CellFormat = 'text' | 'yes_no' | 'date' | 'money' | 'tag' | 'verbatim';
type CellLike = {
  documentId: string; columnKey: string; state: string; value?: unknown; edited?: boolean; reviewStatus?: string;
  citations: ReadonlyArray<{ filename: string; page: number; quote: string; status: string }>;
};

/** Yes/No from a boolean or a "yes…"/"no…" string; null when the value says neither. */
export function yesNo(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^\s*yes\b/i.test(value) || value.trim().toLowerCase() === 'true') return true;
    if (/^\s*no\b/i.test(value) || value.trim().toLowerCase() === 'false') return false;
  }
  return null;
}

/** The value as a lawyer reads it. `{amount, currency}` money, ISO dates and durations stay as the agent wrote them. */
export function valueText(value: unknown, format: CellFormat): string {
  if (value === null || value === undefined || value === '') return '';
  if (format === 'yes_no') {
    const yn = yesNo(value);
    if (yn !== null) return yn ? 'Yes' : 'No';
  }
  if (typeof value === 'object') {
    const m = value as { amount?: unknown; currency?: unknown };
    if (m.amount !== undefined) return `${m.currency ?? ''} ${m.amount}`.trim();
    return JSON.stringify(value);
  }
  return String(value);
}

export function cellText(cell: CellLike | undefined, format: CellFormat): string {
  if (!cell || cell.state === 'pending') return '';
  if (cell.state === 'error') return 'Not read';
  if (cell.state === 'not_found' && !cell.edited) return 'Not addressed';
  return valueText(cell.value, format);
}

/**
 * The CSV of a review: one row per document, the effective value of each column
 * (edited ?? AI), its review state, and one citations column (`file p.N: "quote"`).
 */
export function reviewCsv(
  view: {
    columns: ReadonlyArray<{ key: string; label: string; format: CellFormat }>;
    documents: ReadonlyArray<{ _id: string; filename: string }>;
    cells: ReadonlyArray<CellLike>;
  },
): string[][] {
  const at = new Map(view.cells.map((c) => [`${c.documentId}:${c.columnKey}`, c]));
  const header = ['Document', ...view.columns.flatMap((c) => [c.label, `${c.label} (review)`]), 'Citations'];
  const rows = view.documents.map((d) => {
    const cites: string[] = [];
    const values = view.columns.flatMap((col) => {
      const cell = at.get(`${d._id}:${col.key}`);
      for (const c of cell?.citations ?? []) {
        cites.push(`${col.label}: ${c.filename} p.${c.page}${c.status === 'unverified' ? ' (not found in source)' : ''}: "${c.quote}"`);
      }
      const review = cell?.edited ? 'edited' : cell?.reviewStatus && cell.reviewStatus !== 'none' ? cell.reviewStatus : '';
      return [cellText(cell, col.format), review];
    });
    return [d.filename, ...values, cites.join('\n')];
  });
  return [header, ...rows];
}
