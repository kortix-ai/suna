// How a review cell reads as text: in the grid, the cell panel and the CSV export.

export type CellFormat = 'text' | 'yes_no' | 'date' | 'money' | 'tag' | 'verbatim' | 'number' | 'percent' | 'list';
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

/** A money amount as a number, or null: a number, or a numeric string with optional thousands separators. */
export function moneyAmount(amount: unknown): number | null {
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : null;
  if (typeof amount === 'string' && /^-?[\d,]+(\.\d+)?$/.test(amount.trim())) return Number(amount.replace(/,/g, ''));
  return null;
}

const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const grouped = (n: number) => (Number.isInteger(n) ? WHOLE : CENTS).format(n);

/** The value as a lawyer reads it. `{amount, currency}` money reads "EUR 1,500,000"; ISO dates and durations stay as the agent wrote them. */
export function valueText(value: unknown, format: CellFormat): string {
  if (value === null || value === undefined || value === '') return '';
  if (format === 'yes_no') {
    const yn = yesNo(value);
    if (yn !== null) return yn ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) return value.map((v) => valueText(v, 'text')).filter(Boolean).join('; ');
  if (format === 'percent' && typeof value === 'number') return `${value}%`;
  if (typeof value === 'object') {
    const m = value as { amount?: unknown; currency?: unknown };
    if (m.amount !== undefined) {
      const n = moneyAmount(m.amount);
      return `${m.currency ?? ''} ${n === null ? m.amount : grouped(n)}`.trim();
    }
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

/** A cell's value as a typed spreadsheet cell: numbers stay numbers; money, percentages and ISO dates keep their type. */
export function typedValue(
  cell: CellLike | undefined, format: CellFormat,
): string | number | { pct: number } | { date: string } | { money: number; currency?: string } {
  if (!cell || cell.state === 'pending' || cell.state === 'error') return cellText(cell, format);
  if (cell.state === 'not_found' && !cell.edited) return 'Not addressed';
  const v = cell.value;
  const num = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  if (format === 'number' && num !== null) return num;
  if (format === 'percent' && num !== null) return { pct: num };
  if (v && typeof v === 'object' && !Array.isArray(v) && 'amount' in v) {
    const m = v as { amount?: unknown; currency?: unknown };
    const n = moneyAmount(m.amount);
    if (n !== null) return { money: n, currency: typeof m.currency === 'string' && m.currency.trim() ? m.currency.trim() : undefined };
  }
  if (format === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return { date: v.trim() };
  return valueText(v, format);
}

/**
 * The review as two sheets: "Review" (one row per document, a typed value and
 * a review state per column) and "Citations" (one row per citation).
 */
export function reviewSheets(view: {
  title: string;
  columns: ReadonlyArray<{ key: string; label: string; format: CellFormat }>;
  documents: ReadonlyArray<{ _id: string; filename: string }>;
  cells: ReadonlyArray<CellLike>;
}) {
  const at = new Map(view.cells.map((c) => [`${c.documentId}:${c.columnKey}`, c]));
  const review = [
    ['Document', ...view.columns.flatMap((c) => [c.label, `${c.label} (review)`])],
    ...view.documents.map((d) => [
      d.filename,
      ...view.columns.flatMap((col) => {
        const cell = at.get(`${d._id}:${col.key}`);
        const state = cell?.edited ? 'edited' : cell?.reviewStatus && cell.reviewStatus !== 'none' ? cell.reviewStatus : '';
        return [typedValue(cell, col.format), state];
      }),
    ]),
  ];
  const cites: Array<Array<string | number>> = [['Document', 'Column', 'Source', 'Page', 'Status', 'Quote']];
  for (const d of view.documents) {
    for (const col of view.columns) {
      for (const c of at.get(`${d._id}:${col.key}`)?.citations ?? []) {
        cites.push([d.filename, col.label, c.filename, c.page, c.status === 'unverified' ? 'not found in source' : c.status, c.quote]);
      }
    }
  }
  return [
    { name: view.title || 'Review', rows: review, widths: [34, ...view.columns.flatMap(() => [36, 12])] },
    { name: 'Citations', rows: cites, widths: [34, 22, 34, 7, 18, 80] },
  ];
}
