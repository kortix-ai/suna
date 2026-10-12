/**
 * The markdown table renderer, moved out of `selectable-markdown.tsx`
 * (KRTX-1292). Web: `border rounded-md` wrapper that scrolls horizontally,
 * `w-full` table in `text-sm`, `bg-muted` header, `px-4 py-2` cells. Mobile
 * draws the full grid (a divider between every row and every column), and
 * fades an edge while more columns lie past it. The frame holds the border, so
 * it stays put while the content scrolls.
 *
 * This module imports only leaf modules (`markdown-text`, lib) — the main
 * markdown module imports it, never the reverse.
 */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { View } from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';

import { InlineCode } from '@/components/markdown/inline-code';
import { InlineMath } from '@/components/markdown/math';
import { MarkdownText, openExternalLink } from '@/components/markdown/markdown-text';
import type { MarkdownPalette } from '@/components/markdown/markdown-theme';
import { FONT_FAMILY } from '@/lib/utils/fonts';
import { withAlpha } from '@/lib/utils/theme';
import { RADIUS, TYPE } from '@/lib/markdown/markdown-layout';
import {
  nodeText,
  TABLE_CELL_PADDING_X,
  TABLE_CELL_PADDING_Y,
  fitColumnWidths,
  tableColumnWidths,
  tableSections,
} from '@/lib/markdown/table-layout';

export type AstNode = {
  key: string;
  type: string;
  content?: string;
  sourceInfo?: string;
  markup?: string;
  index: number;
  attributes?: Record<string, unknown>;
  children: AstNode[];
};

/** `SelectableMarkdownTextProps.surface`, for the tables below. */
export const MarkdownSurfaceContext = createContext<string | undefined>(undefined);

/** Inline content of a table cell: bold, italic, strike, code, links. */
function renderCellContent(cell: AstNode, isDark: boolean, palette: MarkdownPalette): React.ReactNode {
  const inline = cell.children ?? [];
  // Cells usually hold one wrapper node around the actual inline content.
  const nodes = inline.length === 1 && inline[0].children?.length ? inline[0].children : inline;
  if (nodes.length === 0) return nodeText(cell);

  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return n.content ?? '';
      case 'softbreak':
      case 'hardbreak':
        return '\n';
      case 'strong':
        return (
          <MarkdownText key={i} style={{ fontFamily: FONT_FAMILY.semibold, fontWeight: '600', color: palette.strong }}>
            {nodeText(n)}
          </MarkdownText>
        );
      case 'em':
        return (
          <MarkdownText key={i} style={{ fontStyle: 'italic', color: palette.em }}>
            {nodeText(n)}
          </MarkdownText>
        );
      case 's':
        return (
          <MarkdownText key={i} style={{ textDecorationLine: 'line-through', color: palette.muted }}>
            {nodeText(n)}
          </MarkdownText>
        );
      case 'code_inline':
        return <InlineCode key={i} code={n.content ?? ''} isDark={isDark} line={TYPE.sm} />;
      case 'math_inline':
        return (
          <InlineMath key={i} tex={n.content ?? ''} isDark={isDark} fontSize={TYPE.sm.fontSize} color={palette.strong} />
        );
      case 'link':
        return (
          <MarkdownText
            key={i}
            accessibilityRole="link"
            style={{
              color: palette.link,
              fontFamily: FONT_FAMILY.medium,
              fontWeight: '500',
              textDecorationLine: 'underline',
              textDecorationColor: palette.linkDecoration,
            }}
            onPress={() => openExternalLink(n.attributes?.href)}
          >
            {nodeText(n)}
          </MarkdownText>
        );
      default:
        return nodeText(n);
    }
  });
}

/** Width of the fade at a table edge that has more columns past it. */
const TABLE_FADE_WIDTH = 24;
const TABLE_BORDER_WIDTH = 0.5;

export function MarkdownTable({ node, palette, isDark }: { node: AstNode; palette: MarkdownPalette; isDark: boolean }) {
  const fill = useContext(MarkdownSurfaceContext) ?? palette.tableBody;
  const [fade, setFade] = useState({ left: false, right: false });
  const [headerHeight, setHeaderHeight] = useState(0);
  const [viewport, setViewport] = useState(0);
  const scroll = useRef({ x: 0, content: 0, viewport: 0, left: false, right: false });
  // Sets state only when an edge flips, not on every scroll frame.
  const updateFade = useCallback(() => {
    const s = scroll.current;
    const left = s.x > 1;
    const right = s.x + s.viewport < s.content - 1;
    if (left === s.left && right === s.right) return;
    s.left = left;
    s.right = right;
    setFade({ left, right });
  }, []);

  const sections = tableSections(node);
  const colCount = Math.max(0, ...sections.flatMap((s) => s.rows.map((r) => r.length)));
  if (colCount === 0) return <View />;

  const colWidths = fitColumnWidths(tableColumnWidths(sections, colCount), viewport);

  let rowIndex = 0;
  return (
    <View
      style={{
        borderWidth: TABLE_BORDER_WIDTH,
        borderColor: palette.border,
        borderRadius: RADIUS.sm,
        overflow: 'hidden',
        backgroundColor: fill,
      }}
    >
      <GHScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ minWidth: '100%' }}
        scrollEventThrottle={16}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          Object.assign(scroll.current, { x: contentOffset.x, content: contentSize.width, viewport: layoutMeasurement.width });
          updateFade();
        }}
        onContentSizeChange={(width) => {
          scroll.current.content = width;
          updateFade();
        }}
        onLayout={(e) => {
          scroll.current.viewport = e.nativeEvent.layout.width;
          setViewport(e.nativeEvent.layout.width);
          updateFade();
        }}
      >
        <View style={{ flexGrow: 1 }}>
          {sections.map((section, sIdx) =>
            section.rows.map((cells, rIdx) => {
              const divider = rowIndex++ > 0;
              return (
                <View
                  key={`${sIdx}-${rIdx}`}
                  // GFM has one header row: the fade paints its colour over that height.
                  onLayout={section.isHeader && rIdx === 0 ? (e) => setHeaderHeight(e.nativeEvent.layout.height) : undefined}
                  style={{
                    flexDirection: 'row',
                    borderTopWidth: divider ? TABLE_BORDER_WIDTH : 0,
                    borderTopColor: palette.border,
                    backgroundColor: section.isHeader ? palette.tableHeader : undefined,
                  }}
                >
                  {cells.map((cell, cIdx) => (
                    <View
                      key={cIdx}
                      style={{
                        width: colWidths[cIdx],
                        // Every column is left-aligned: GFM `:---:` / `---:` markers are
                        // ignored, and Yoga places the text, sized to its content, at the left edge.
                        alignItems: 'flex-start',
                        borderLeftWidth: cIdx > 0 ? TABLE_BORDER_WIDTH : 0,
                        borderLeftColor: palette.border,
                        paddingHorizontal: TABLE_CELL_PADDING_X,
                        paddingVertical: TABLE_CELL_PADDING_Y,
                      }}
                    >
                      <MarkdownText
                        selectable
                        numberOfLines={section.isHeader ? 1 : undefined}
                        style={{
                          fontFamily: section.isHeader ? FONT_FAMILY.semibold : FONT_FAMILY.regular,
                          fontWeight: section.isHeader ? '600' : '400',
                          fontSize: TYPE.sm.fontSize,
                          lineHeight: TYPE.sm.lineHeight,
                          color: palette.strong,
                          textAlign: 'left',
                        }}
                      >
                        {renderCellContent(cell, isDark, palette)}
                      </MarkdownText>
                    </View>
                  ))}
                </View>
              );
            }),
          )}
        </View>
      </GHScrollView>
      {fade.left ? <TableEdgeFade side="left" headerHeight={headerHeight} header={palette.tableHeader} body={fill} /> : null}
      {fade.right ? <TableEdgeFade side="right" headerHeight={headerHeight} header={palette.tableHeader} body={fill} /> : null}
    </View>
  );
}

/** A fade from the table's fill (opaque at the edge) to clear: the header colour over the header row, the body fill below. */
function TableEdgeFade({ side, headerHeight, header, body }: { side: 'left' | 'right'; headerHeight: number; header: string; body: string }) {
  const colors = (fill: string) => (side === 'left' ? [fill, withAlpha(fill, 0)] : [withAlpha(fill, 0), fill]) as [string, string];
  return (
    <View
      testID={`table-fade-${side}`}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, bottom: 0, [side]: 0, width: TABLE_FADE_WIDTH }}
    >
      {headerHeight > 0 ? (
        <LinearGradient colors={colors(header)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ height: headerHeight }} />
      ) : null}
      <LinearGradient colors={colors(body)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
    </View>
  );
}
