import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid';
import { describe, expect, test } from 'bun:test';

import { gridSelectionToTsv } from './csv-copy';

const rows = [
  ['Alpha', '1234.5', 'Berlin'],
  ['Beta', '42', 'Paris'],
  ['Gamma', '7', 'Lyon, France'],
];

function selection(overrides: Partial<GridSelection>): GridSelection {
  return { columns: CompactSelection.empty(), rows: CompactSelection.empty(), ...overrides };
}

describe('gridSelectionToTsv', () => {
  test('copies one cell as its bare value', () => {
    const cell = selection({
      current: { cell: [1, 0], range: { x: 1, y: 0, width: 1, height: 1 }, rangeStack: [] },
    });
    expect(gridSelectionToTsv(cell, rows, 3)).toBe('1234.5');
  });

  test('copies a range as tab-separated rows; commas stay unquoted', () => {
    const range = selection({
      current: { cell: [0, 1], range: { x: 0, y: 1, width: 3, height: 2 }, rangeStack: [] },
    });
    expect(gridSelectionToTsv(range, rows, 3)).toBe('Beta\t42\tParis\nGamma\t7\tLyon, France');
  });

  test('copies whole selected rows and whole selected columns', () => {
    expect(
      gridSelectionToTsv(selection({ rows: CompactSelection.fromSingleSelection(2) }), rows, 3),
    ).toBe('Gamma\t7\tLyon, France');
    expect(
      gridSelectionToTsv(selection({ columns: CompactSelection.fromSingleSelection(1) }), rows, 3),
    ).toBe('1234.5\n42\n7');
  });

  test('quotes a value that holds a tab, newline, or quote, so it stays one cell', () => {
    const cell = selection({
      current: { cell: [0, 0], range: { x: 0, y: 0, width: 1, height: 1 }, rangeStack: [] },
    });
    expect(gridSelectionToTsv(cell, [['say "hi"\nthere']], 1)).toBe('"say ""hi""\nthere"');
  });

  test('returns null when nothing is selected', () => {
    expect(gridSelectionToTsv(selection({}), rows, 3)).toBeNull();
  });
});
