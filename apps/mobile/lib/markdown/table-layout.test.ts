import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  nodeText,
  TABLE_CELL_PADDING_X,
  tableCellAlign,
  tableColumnWidths,
  tableSections,
  type TableAstNode,
} from './table-layout';

const SOURCE = [
  '| Name | Status | Count |',
  '|:-----|:------:|------:|',
  '| `inline_code_value` | [a link](https://example.com) | 1 |',
  '| short | ok | 22 |',
  `| ${'a very long cell that must wrap inside its column '.repeat(8)} | **bold** | 333 |`,
].join('\n');

// The library's own parser, as the app runs it, so the AST has the rendered shape.
// Process-global: relies on `bun test --isolate` so it cannot leak into other files.
mock.module('react-native', () => ({ StyleSheet: { flatten: (style: unknown) => style } }));
const appRequire = createRequire(import.meta.url);
const libraryRoot = realpathSync(join(appRequire.resolve('react-native-markdown-display/package.json'), '..'));
const MarkdownIt = createRequire(join(libraryRoot, 'package.json'))('markdown-it') as (o: { typographer: boolean }) => unknown;
type Parser = (source: string, renderer: (nodes: TableAstNode[]) => unknown, md: unknown) => TableAstNode[];
let parser: Parser;
beforeAll(async () => {
  parser = (await import(join(libraryRoot, 'src/lib/parser.js'))).default;
});

function parseTable(markdown: string): TableAstNode {
  const table = parser(markdown, (nodes) => nodes, MarkdownIt({ typographer: true })).find((n) => n.type === 'table');
  if (!table) throw new Error('no table in AST');
  return table;
}

describe('table column alignment', () => {
  let rows: TableAstNode[][];
  beforeAll(() => {
    rows = tableSections(parseTable(SOURCE)).flatMap((s) => s.rows);
  });

  test('markdown-it puts GFM alignment on every th and td as a style attribute', () => {
    expect(rows).toHaveLength(4);
    expect(rows[0][1].attributes?.style).toBe('text-align:center');
    expect(rows[2][2].attributes?.style).toBe('text-align:right');
  });

  test(':--- is left, :---: is centered, ---: is right, in the header and every body row', () => {
    for (const row of rows) {
      expect(row.map(tableCellAlign)).toEqual(['left', 'center', 'right']);
    }
  });

  test('a table with no alignment markers is left-aligned, including cells with code, links and bold', () => {
    const plain = tableSections(parseTable('| a | b |\n|---|---|\n| `x` | [l](https://example.com) |\n| **b** | $y$ |'));
    for (const row of plain.flatMap((s) => s.rows)) {
      expect(row.map(tableCellAlign)).toEqual(['left', 'left']);
    }
  });

  test('a cell without attributes is left', () => {
    expect(tableCellAlign(undefined)).toBe('left');
    expect(tableCellAlign({ type: 'td' })).toBe('left');
  });
});

describe('table column widths', () => {
  let sections: ReturnType<typeof tableSections>;
  let widths: number[];
  beforeAll(() => {
    sections = tableSections(parseTable(SOURCE));
    widths = tableColumnWidths(sections, 3);
  });

  test('one width per column, shared by the header and every body row', () => {
    expect(widths).toHaveLength(3);
    for (const section of sections) for (const row of section.rows) expect(row).toHaveLength(widths.length);
  });

  test('a long cell is capped so it wraps, and the short columns stay narrow', () => {
    const longCellText = nodeText(sections[1].rows[2][0]);
    expect(longCellText.length).toBeGreaterThan(300);
    expect(widths[0]).toBe(240 + 2 * TABLE_CELL_PADDING_X);
    expect(widths[2]).toBeLessThan(widths[0]);
  });
});
