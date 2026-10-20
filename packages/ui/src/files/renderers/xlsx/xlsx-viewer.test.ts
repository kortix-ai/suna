import { describe, expect, test } from 'bun:test';

import { readXlsxSelectionText } from './xlsx-viewer';

// Worker-backed sheets: the rows come back sparse, as the worker's getRowsBatch returns them.
const workerRows = [
  {
    index: 0,
    cells: [
      { col: 0, value: 'Name' },
      { col: 1, value: 'Amount' },
      { col: 2, value: 'City' },
    ],
  },
  {
    index: 1,
    cells: [
      { col: 0, value: 'Alpha' },
      { col: 1, value: '1,234.50' },
      { col: 2, value: 'Berlin' },
    ],
  },
  {
    index: 2,
    cells: [
      { col: 0, value: 'Beta' },
      { col: 2, value: 'Paris' },
    ],
  },
];

function workerController(overrides: Record<string, unknown> = {}) {
  const requests: Array<[number, number, number]> = [];
  const controller = {
    activeCell: null,
    activeSheet: { maxUsedCol: 2, maxUsedRow: 2, workbookSheetIndex: 3 },
    selection: null,
    getRowsBatchAsync: async (sheetIndex: number, startRow: number, rowCount: number) => {
      requests.push([sheetIndex, startRow, rowCount]);
      return workerRows.filter((row) => row.index >= startRow && row.index < startRow + rowCount);
    },
    ...overrides,
  } as unknown as Parameters<typeof readXlsxSelectionText>[0];
  return { controller, requests };
}

describe('readXlsxSelectionText', () => {
  test('copies the active cell when nothing is range-selected', async () => {
    const { controller } = workerController({ activeCell: { row: 1, col: 0 } });
    expect(await readXlsxSelectionText(controller)).toBe('Alpha');
  });

  test('copies a range as tab-separated rows, blanks for empty cells', async () => {
    const { controller } = workerController({
      selection: { start: { row: 1, col: 0 }, end: { row: 2, col: 2 } },
    });
    expect(await readXlsxSelectionText(controller)).toBe('Alpha\t1,234.50\tBerlin\nBeta\t\tParis');
  });

  test('clamps a whole-column selection to the used range', async () => {
    const { controller, requests } = workerController({
      selection: { start: { row: 1_048_575, col: 1 }, end: { row: 0, col: 1 } },
    });
    expect(await readXlsxSelectionText(controller)).toBe('Amount\n1,234.50\n');
    expect(requests).toEqual([[3, 0, 3]]);
  });

  test('returns null when there is nothing to copy or no worker', async () => {
    expect(await readXlsxSelectionText(workerController().controller)).toBeNull();
    const noWorker = workerController({
      activeCell: { row: 0, col: 0 },
      getRowsBatchAsync: undefined,
    });
    expect(await readXlsxSelectionText(noWorker.controller)).toBeNull();
  });
});
