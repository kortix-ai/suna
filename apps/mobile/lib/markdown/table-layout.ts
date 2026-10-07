import { web } from './markdown-layout';

/** The part of a react-native-markdown-display AST node the table reads. */
export type TableAstNode = {
  type: string;
  content?: string;
  attributes?: Record<string, unknown>;
  children?: TableAstNode[];
};

export type TableAlign = 'left' | 'center' | 'right';

/** Roobert average advance at `text-sm`, for estimating table column widths. */
const TABLE_CHAR_WIDTH = 7.7;
export const TABLE_CELL_PADDING_X = web(4);
export const TABLE_CELL_PADDING_Y = web(2);
const TABLE_MIN_COLUMN = 44;
/** Body cells wrap past this width; headers never wrap (`whitespace-nowrap`). */
const TABLE_MAX_BODY_TEXT = 240;

/** Plain text of an AST node. */
export function nodeText(node: TableAstNode | undefined): string {
  if (!node) return '';
  if (node.content) return node.content;
  return (node.children ?? []).map(nodeText).join('');
}

/**
 * GFM column alignment. markdown-it puts `:---:` and `---:` on every `th` and
 * `td` of the column as `attributes.style` (`text-align:center|right`); `:---`
 * and no marker are left.
 */
export function tableCellAlign(cell: TableAstNode | undefined): TableAlign {
  const style = cell?.attributes?.style;
  const align = typeof style === 'string' ? /text-align:\s*(left|center|right)/.exec(style)?.[1] : undefined;
  return align === 'center' || align === 'right' ? align : 'left';
}

export type TableSection<N extends TableAstNode = TableAstNode> = { isHeader: boolean; rows: N[][] };

/** The `thead`/`tbody` rows of a `table` node, each row reduced to its cells. */
export function tableSections<N extends TableAstNode>(table: N): TableSection<N>[] {
  const sections: TableSection<N>[] = [];
  for (const section of (table.children ?? []) as N[]) {
    const rows: N[][] = [];
    for (const row of (section.children ?? []) as N[]) {
      if (row.type === 'tr') rows.push(((row.children ?? []) as N[]).filter((c) => c.type === 'th' || c.type === 'td'));
    }
    if (rows.length > 0) sections.push({ isHeader: section.type === 'thead', rows });
  }
  return sections;
}

/** One width per column, shared by every row, header included. */
export function tableColumnWidths(sections: TableSection[], colCount: number): number[] {
  const colWidths: number[] = [];
  for (let col = 0; col < colCount; col++) {
    let header = 0;
    let body = 0;
    for (const section of sections) {
      for (const row of section.rows) {
        const width = nodeText(row[col]).length * TABLE_CHAR_WIDTH;
        if (section.isHeader) header = Math.max(header, width);
        else body = Math.max(body, Math.min(width, TABLE_MAX_BODY_TEXT));
      }
    }
    colWidths.push(Math.max(Math.max(header, body) + 2 * TABLE_CELL_PADDING_X, TABLE_MIN_COLUMN));
  }
  return colWidths;
}

/**
 * Whole-point column widths that fill the viewport. Extra room is shared in
 * proportion and the last column takes the rounding remainder. Every row uses
 * these exact widths, so each column divider is one straight line.
 */
export function fitColumnWidths(widths: number[], viewport: number): number[] {
  const natural = widths.map((w) => Math.ceil(w));
  const total = natural.reduce((sum, w) => sum + w, 0);
  const target = Math.floor(viewport);
  if (total === 0 || total >= target) return natural;
  const fitted = natural.map((w) => Math.floor((w * target) / total));
  fitted[fitted.length - 1] += target - fitted.reduce((sum, w) => sum + w, 0);
  return fitted;
}
