import type { GridSelection } from '@glideapps/glide-data-grid';

function sequence(start: number, length: number) {
  return Array.from({ length }, (_, index) => start + index);
}

/** A value with a tab, newline, or quote is quoted so a spreadsheet pastes it as one cell. */
function escapeTsvValue(value: string) {
  return /[\t\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The selected cells as plain tab-separated text, the same shape the XLSX
 * viewer copies. Glide's own copy also writes an unstyled HTML table, which
 * rich paste targets (chat, docs, mail) prefer and render as a bare table.
 * Returns null when nothing is selected.
 */
export function gridSelectionToTsv(
  selection: GridSelection,
  rows: string[][],
  columnCount: number,
): string | null {
  let rowIndexes: number[];
  let columnIndexes: number[];

  if (selection.current) {
    const { x, y, width, height } = selection.current.range;
    rowIndexes = sequence(y, height);
    columnIndexes = sequence(x, width);
  } else if (selection.rows.length > 0) {
    rowIndexes = selection.rows.toArray();
    columnIndexes = sequence(0, columnCount);
  } else if (selection.columns.length > 0) {
    rowIndexes = sequence(0, rows.length);
    columnIndexes = selection.columns.toArray();
  } else {
    return null;
  }

  return rowIndexes
    .map((row) => columnIndexes.map((col) => escapeTsvValue(rows[row]?.[col] ?? '')).join('\t'))
    .join('\n');
}
