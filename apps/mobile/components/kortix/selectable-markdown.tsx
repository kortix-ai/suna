/**
 * SelectableMarkdownText
 *
 * Renders chat markdown with react-native-markdown-display, styled to match
 * web's `apps/web/src/components/markdown/unified-markdown.tsx`: every size,
 * margin, and colour comes from `lib/markdown/markdown-layout.ts` (web's
 * values at web's spacing scale) and `components/markdown/markdown-theme.ts`
 * (THEME tokens). Fenced code renders through `components/markdown/
 * code-block.tsx` with Shiki `min-light` / `min-dark` highlighting; inline code
 * through `components/markdown/inline-code.tsx`.
 *
 * Math: `$…$`, `$$…$$`, and ```math / latex / tex / katex fences render as SVG
 * (`components/markdown/math.tsx`). The text first goes through
 * `prepareMarkdownForMath` and the markdown-it math rule
 * (`lib/markdown/math-plugin.ts`), which pair dollars the way web's remark-math
 * does. Mermaid fences, and unlabelled fences that start with a diagram type,
 * render as diagrams (`components/markdown/mermaid/MermaidBlock.tsx`).
 *
 * Selection is native on both platforms: long press selects a range, and the
 * handles extend it within one block (a paragraph, heading, list item, or
 * table cell). Android uses React Native's selectable `Text`. iOS uses a
 * `UITextView` (`react-native-uitextview`), because React Native's iOS `Text`
 * only copies a whole paragraph. A binary built before that native view keeps
 * the old double-tap sheet (`IOS_TEXT_VIEW`).
 *
 * Streaming: the text is split into top-level blocks (`splitMarkdown`), and
 * each block renders in its own memoized component keyed by its position.
 * When a message grows, only the last block's string changes, so completed
 * blocks are neither re-parsed nor remounted. The last block re-parses on every
 * change; its AST keys are node paths
 * (`patches/react-native-markdown-display+7.0.2.patch`), so its native views
 * update in place instead of remounting. A block that appears after the
 * message mounted fades in; a fence that is still open renders plain and
 * highlights once it closes.
 *
 * Untrusted content: message markdown comes from the agent. Links open only for
 * http(s) and mailto, and images are never fetched; they render as a
 * placeholder that opens the source in the browser on tap.
 */

import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  TextStyle,
  View,
  Text as RNText,
  Pressable,
  LogBox,
  Platform,
  UIManager,
  useWindowDimensions,
  type TextProps,
} from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import type { MarkdownTextInput as MarkdownTextInputComponent } from '@expensify/react-native-live-markdown';
import Markdown, { MarkdownIt, type MarkdownProps } from 'react-native-markdown-display';
import { BottomSheetModal, BottomSheetView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { CopyIcon as Copy } from '@/lib/icons';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { useColorScheme } from 'nativewind';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';
import { FONT_FAMILY } from '@/lib/utils/fonts';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { log } from '@/lib/logger';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { isMathFenceLanguage, isMermaidCode, prepareMarkdownForMath } from '@kortix/shared';
import { CodeBlock, fenceCode, fenceLanguage } from '@/components/markdown/code-block';
import { InlineCode } from '@/components/markdown/inline-code';
import { BlockMath, InlineMath } from '@/components/markdown/math';
import { MermaidBlock } from '@/components/markdown/mermaid/MermaidBlock';
import { mathPlugin } from '@/lib/markdown/math-plugin';
import { markdownPalette, type MarkdownPalette } from '@/components/markdown/markdown-theme';
import { isMarkdownSeparatorBlock, splitMarkdown } from '@/lib/markdown/split-blocks';
import { isSafeExternalLink } from '@/lib/markdown/safe-link';
import { groupImageBlocks, imageSourceKey } from '@/lib/markdown/markdown-image';
import { MarkdownImage, MarkdownImageGallery, MarkdownImagesContext, type MarkdownRemoteImages } from '@/components/markdown/markdown-image';
import {
  classifyBlock,
  collapsedGap,
  kindOfNode,
  orderedListGutter,
  RADIUS,
  TYPE,
  web,
  type BlockKind,
  type StackContext,
} from '@/lib/markdown/markdown-layout';
import {
  nodeText,
  TABLE_CELL_PADDING_X,
  TABLE_CELL_PADDING_Y,
  fitColumnWidths,
  tableColumnWidths,
  tableSections,
} from '@/lib/markdown/table-layout';
import { openLink } from '@/lib/utils/open-link';

// The component's own module, not the package root: the root also exports
// `parseExpensiMark`, which loads all of `expensify-common` (1.5 MB) at boot.
// The app passes its own parser (`markdownParser`) and never calls it. A
// `require`, so tsc reads the root's declarations and not the package source.
const MarkdownTextInput: typeof MarkdownTextInputComponent =
  require('@expensify/react-native-live-markdown/src/MarkdownTextInput').default;

// Suppress known warning from react-native-markdown-display library
LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);

/**
 * The running iOS binary has `react-native-uitextview`'s native view. An OTA
 * update can reach a binary built before it: that binary renders plain `Text`
 * and keeps the double-tap selection sheet.
 */
const IOS_TEXT_VIEW = Platform.OS === 'ios' && UIManager.hasViewManagerConfig('RNUITextView');

/**
 * Every text node of the markdown. On iOS it is a `UITextView`: the outermost
 * one is the selectable view, nested ones are its styled spans, so every text
 * rule must use this and never `RNText`. Elsewhere it is React Native's `Text`,
 * which reads `selectable` from the outermost node only.
 */
function MarkdownText(props: TextProps) {
  return IOS_TEXT_VIEW ? <UITextView uiTextView {...props} /> : <RNText {...props} />;
}

/**
 * Android: a selectable text node with no press handler of its own never
 * delivers a tap to a nested link (KRTX-562). A no-op handler on the outer node
 * restores the link's `onPress` and keeps native selection (verified on a
 * Pixel 9 emulator, RN 0.85). `accessibilityRole="text"` keeps the handler
 * from announcing every paragraph as a link.
 */
const ANDROID_LINK_TAPS: Partial<TextProps> =
  Platform.OS === 'android' ? { onPress: noop, accessibilityRole: 'text' } : {};

export interface SelectableMarkdownTextProps {
  /** The markdown text content to render */
  children: string;
  /** Accepted for compatibility; the markdown renderer does not apply it. */
  style?: TextStyle;
  /** Whether to use dark mode (if not provided, will use color scheme hook) */
  isDark?: boolean;
  /**
   * The message is still streaming. When given, it decides whether an open
   * fence at the end holds its highlighting. When omitted, an open fence
   * highlights after its text has not changed for `OPEN_FENCE_SETTLE_MS`, so
   * a finished message whose last fence was never closed still highlights.
   */
  isStreaming?: boolean;
  /**
   * `'load'` where the project's agent wrote the text (a reply, a project
   * file): remote http(s) images load, as on web. Default `'placeholder'`.
   * Sandbox images load either way.
   */
  remoteImages?: MarkdownRemoteImages;
  /**
   * The colour behind the text, when it is not the page background (a sheet,
   * a card). Tables fill with it, and their edge fades start from it.
   */
  surface?: string;
}

/**
 * Opens a link from message markdown when its scheme is http(s) or mailto.
 * Any other scheme is ignored, and a failed open never becomes an unhandled
 * rejection.
 */
function openExternalLink(href: unknown) {
  if (!isSafeExternalLink(href)) return;
  openLink(href).catch(() => {});
}

/**
 * `onLinkPress` for library rules the app does not override (`blocklink`, a
 * link around an image). Returning false stops the library from opening the
 * URL itself.
 */
function handleLibraryLinkPress(url: string): boolean {
  openExternalLink(url);
  return false;
}


/**
 * The fence at the end of the current block has no closing marker yet. Code
 * blocks read it to hold highlighting and follow the newest line.
 */
const OpenFenceContext = createContext(false);

/** `SelectableMarkdownTextProps.surface`, for the tables below. */
export const MarkdownSurfaceContext = createContext<string | undefined>(undefined);

type AstNode = {
  key: string;
  type: string;
  content?: string;
  sourceInfo?: string;
  markup?: string;
  index: number;
  attributes?: Record<string, unknown>;
  children: AstNode[];
};

/**
 * Stacks rendered constructs with CSS-style collapsed margins: the gap between
 * two siblings is the larger of the first's bottom and the second's top
 * margin, and the first sibling has none. `nodes` and `children` are the
 * parallel AST / rendered arrays every library rule receives.
 */
function stack(nodes: AstNode[], children: React.ReactNode[], context: StackContext): React.ReactNode[] {
  let previous: BlockKind | null = null;
  return children.map((child, index) => {
    const node = nodes[index];
    const kind = node ? kindOfNode(node.type) : null;
    if (!kind) return child;
    const gap = collapsedGap(previous, kind, context);
    previous = kind;
    if (!gap) return child;
    return (
      <View key={`stack-${node.key}`} style={{ marginTop: gap }}>
        {child}
      </View>
    );
  });
}

function hasParent(parents: AstNode[], type: string): boolean {
  return parents.some((parent) => parent.type === type);
}

/** Web's `MarkdownCode` routing: Mermaid first, then math fences, then code. */
function FencedCode({ node, isDark }: { node: AstNode; isDark: boolean }) {
  const isStreaming = useContext(OpenFenceContext);
  const code = fenceCode(node.content);
  const language = fenceLanguage(node.sourceInfo);
  if (isMermaidCode(language, code)) {
    return <MermaidBlock chart={code} language={language} isDark={isDark} isStreaming={isStreaming} />;
  }
  if (isMathFenceLanguage(language)) {
    return <BlockMath tex={code} isDark={isDark} variant="fence" />;
  }
  return <CodeBlock code={code} language={language} isDark={isDark} isStreaming={isStreaming} />;
}

/** Render rules for react-native-markdown-display, one set per theme. */
const createMarkdownRules = (isDark: boolean) => {
  const palette = markdownPalette(isDark);
  return {
    body: (node: AstNode, children: React.ReactNode[], _parent: AstNode[], styles: any) => (
      <View key={node.key} style={styles._VIEW_SAFE_body}>
        {stack(node.children, children, 'root')}
      </View>
    ),
    text: (node: AstNode, _children: unknown, _parent: unknown, styles: any, inheritedStyles: any = {}) => (
      <MarkdownText key={node.key} style={[inheritedStyles, styles.text]}>
        {node.content}
      </MarkdownText>
    ),
    // The outermost text node: the one native selection reads `selectable` from.
    textgroup: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <MarkdownText key={node.key} style={styles.textgroup} selectable {...ANDROID_LINK_TAPS}>
        {children}
      </MarkdownText>
    ),
    paragraph: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} style={styles._VIEW_SAFE_paragraph}>
        {children}
      </View>
    ),
    strong: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <MarkdownText key={node.key} style={styles.strong}>
        {children}
      </MarkdownText>
    ),
    em: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <MarkdownText key={node.key} style={styles.em}>
        {children}
      </MarkdownText>
    ),
    s: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <MarkdownText key={node.key} style={styles.s}>
        {children}
      </MarkdownText>
    ),
    // Links: only http(s) and mailto open.
    link: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <MarkdownText
        key={node.key}
        style={styles.link}
        accessibilityRole="link"
        onPress={() => openExternalLink(node.attributes?.href)}
      >
        {children}
      </MarkdownText>
    ),
    // Images: the image itself where it may load (`MarkdownImagesContext`),
    // else the placeholder card. Node keys are positions, so the source is in
    // the key: a different image at the same position mounts fresh load state.
    image: (node: AstNode) => (
      <MarkdownImage
        key={`${node.key}:${imageSourceKey(String(node.attributes?.src ?? ''))}`}
        src={typeof node.attributes?.src === 'string' ? node.attributes.src : ''}
        alt={typeof node.attributes?.alt === 'string' ? node.attributes.alt : ''}
        isDark={isDark}
      />
    ),
    heading1: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} accessibilityRole="header" style={styles._VIEW_SAFE_heading1}>
        {children}
      </View>
    ),
    heading2: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} accessibilityRole="header" style={styles._VIEW_SAFE_heading2}>
        {children}
      </View>
    ),
    heading3: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} accessibilityRole="header" style={styles._VIEW_SAFE_heading3}>
        {children}
      </View>
    ),
    heading4: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} accessibilityRole="header" style={styles._VIEW_SAFE_heading4}>
        {children}
      </View>
    ),
    heading5: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} accessibilityRole="header" style={styles._VIEW_SAFE_heading5}>
        {children}
      </View>
    ),
    heading6: (node: AstNode, children: React.ReactNode, _parent: unknown, styles: any) => (
      <View key={node.key} accessibilityRole="header" style={styles._VIEW_SAFE_heading6}>
        {children}
      </View>
    ),
    // Lists: `space-y-1` between items.
    bullet_list: (node: AstNode, children: React.ReactNode[]) => (
      <View key={node.key}>
        {children.map((child, index) =>
          index === 0 ? child : (
            <View key={`item-${node.children[index]?.key ?? index}`} style={{ marginTop: web(1) }}>
              {child}
            </View>
          ),
        )}
      </View>
    ),
    ordered_list: (node: AstNode, children: React.ReactNode[]) => (
      <View key={node.key}>
        {children.map((child, index) =>
          index === 0 ? child : (
            <View key={`item-${node.children[index]?.key ?? index}`} style={{ marginTop: web(1) }}>
              {child}
            </View>
          ),
        )}
      </View>
    ),
    // `list-outside`: the marker hangs in the list's inline-start padding,
    // end-aligned against the item text.
    list_item: (node: AstNode, children: React.ReactNode[], parent: AstNode[], styles: any) => {
      const ordered = parent[0]?.type === 'ordered_list';
      const list = parent[0];
      const rawStart = Number(list?.attributes?.start);
      const start = Number.isFinite(rawStart) ? rawStart : 1;
      const gutter = ordered ? orderedListGutter(list?.children.length ?? 1, start) : web(6);
      return (
        <View key={node.key} style={{ flexDirection: 'row' }}>
          <RNText
            accessible={false}
            style={[
              styles.list_item_marker,
              { width: gutter, color: ordered ? palette.orderedMarker : palette.bulletMarker },
              ordered ? styles.ordered_list_marker : null,
            ]}
          >
            {ordered ? `${start + node.index}${node.markup ?? '.'}` : '•'}
          </RNText>
          <View style={{ flex: 1, minWidth: 0 }}>{stack(node.children, children, 'list')}</View>
        </View>
      );
    },
    blockquote: (node: AstNode, children: React.ReactNode[], _parent: unknown, styles: any) => (
      <View key={node.key} style={styles._VIEW_SAFE_blockquote}>
        {stack(node.children, children, 'blockquote')}
      </View>
    ),
    hr: (node: AstNode) => <MarkdownRule key={node.key} palette={palette} />,
    fence: (node: AstNode) => <FencedCode key={node.key} node={node} isDark={isDark} />,
    code_block: (node: AstNode) => (
      <CodeBlock key={node.key} code={fenceCode(node.content)} language="" isDark={isDark} />
    ),
    // Inline code: a rounded chip placed on the baseline of the text around it.
    code_inline: (node: AstNode, _children: unknown, parent: AstNode[], _styles: unknown, inheritedStyles: TextStyle = {}) => (
      <InlineCode
        key={node.key}
        code={node.content ?? ''}
        isDark={isDark}
        insideLink={hasParent(parent, 'link')}
        line={{
          fontSize: inheritedStyles.fontSize ?? TYPE.body.fontSize,
          lineHeight: inheritedStyles.lineHeight ?? TYPE.body.lineHeight,
        }}
      />
    ),
    // Math: `$…$` sits in the line at the surrounding text's size and colour.
    math_inline: (node: AstNode, _children: unknown, _parent: unknown, _styles: unknown, inheritedStyles: TextStyle = {}) => (
      <InlineMath
        key={node.key}
        tex={node.content ?? ''}
        isDark={isDark}
        fontSize={inheritedStyles.fontSize}
        color={typeof inheritedStyles.color === 'string' ? inheritedStyles.color : undefined}
      />
    ),
    math_block: (node: AstNode) => <BlockMath key={node.key} tex={node.content ?? ''} isDark={isDark} />,
    // Table: rendered whole from the AST so every row shares column widths.
    table: (node: AstNode) => <MarkdownTable key={node.key} node={node} palette={palette} isDark={isDark} />,
  };
};

/** `hr`: `border-t border-border`, no height of its own. */
function MarkdownRule({ palette }: { palette: MarkdownPalette }) {
  return <View style={{ height: 1, backgroundColor: palette.border }} />;
}

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

/**
 * Web: `border rounded-md` wrapper that scrolls horizontally, `w-full` table in
 * `text-sm`, `bg-muted` header, `px-4 py-2` cells. Mobile draws the full grid
 * (a divider between every row and every column), and fades an edge while
 * more columns lie past it. The frame holds the border, so it stays put while
 * the content scrolls.
 */
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

/** Web heading classes: `text-foreground font-semibold`, sizes and margins in markdown-layout. */
const heading = (palette: MarkdownPalette, size: { fontSize: number; lineHeight: number }) => ({
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  fontSize: size.fontSize,
  lineHeight: size.lineHeight,
  fontFamily: FONT_FAMILY.semibold,
  fontWeight: '600' as const,
  color: palette.strong,
});

/**
 * Style objects for react-native-markdown-display. Text properties cascade to
 * every text node below the element (the library's `inheritedStyles`); view
 * properties apply to the element's own View (`_VIEW_SAFE_*`).
 */
const createMarkdownStyles = (isDark: boolean) => {
  const palette = markdownPalette(isDark);
  return StyleSheet.create({
    // `.kortix-markdown text-[15px]` + paragraph `text-foreground/95 leading-relaxed font-medium`.
    body: {
      color: palette.text,
      fontSize: TYPE.body.fontSize,
      lineHeight: TYPE.body.lineHeight,
      fontFamily: FONT_FAMILY.medium,
      fontWeight: '500',
    },
    text: {},
    textgroup: {},
    paragraph: {
      marginTop: 0,
      marginBottom: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      width: '100%',
    },
    strong: { fontFamily: FONT_FAMILY.semibold, fontWeight: '600', color: palette.strong },
    em: { fontStyle: 'italic', color: palette.em },
    s: {
      textDecorationLine: 'line-through',
      textDecorationColor: palette.mutedDecoration,
      color: palette.muted,
    },
    link: {
      color: palette.link,
      fontFamily: FONT_FAMILY.medium,
      fontWeight: '500',
      textDecorationLine: 'underline',
      textDecorationColor: palette.linkDecoration,
    },
    heading1: heading(palette, TYPE.xl),
    heading2: heading(palette, TYPE.xl),
    heading3: heading(palette, TYPE.lg),
    heading4: heading(palette, TYPE.lg),
    heading5: heading(palette, TYPE.base),
    // `tracking-wide` = 0.025em.
    heading6: { ...heading(palette, TYPE.base), letterSpacing: 0.4 },
    list_item_marker: {
      fontSize: TYPE.body.fontSize,
      lineHeight: TYPE.body.lineHeight,
      fontFamily: FONT_FAMILY.medium,
      fontWeight: '500',
      textAlign: 'right',
      paddingRight: 4,
    },
    ordered_list_marker: { fontVariant: ['tabular-nums'] },
    blockquote: {
      borderLeftWidth: 2,
      borderLeftColor: palette.border,
      paddingLeft: web(6),
      color: palette.muted,
      fontStyle: 'italic',
      backgroundColor: 'transparent',
      marginLeft: 0,
      paddingHorizontal: 0,
    },
  });
};

// react-native-markdown-display rebuilds its renderer (StyleSheet.create over
// every style key) whenever one of these props changes identity, and its
// defaults are new objects on every render. Module-level values keep one
// renderer per theme and one markdown-it instance.
const MARKDOWN_IT = MarkdownIt({ typographer: true }).use(
  mathPlugin as unknown as Parameters<ReturnType<typeof MarkdownIt>['use']>[0],
);
const LIGHT_MARKDOWN_RULES = createMarkdownRules(false);
const DARK_MARKDOWN_RULES = createMarkdownRules(true);
const LIGHT_MARKDOWN_STYLES = createMarkdownStyles(false);
const DARK_MARKDOWN_STYLES = createMarkdownStyles(true);
const TOP_LEVEL_MAX_EXCEEDED_ITEM = null;
// The `image` rule never loads images. Without allowed handlers and a default
// handler, the library's own image rule would render nothing as well.
const ALLOWED_IMAGE_HANDLERS: string[] = [];
const DEFAULT_IMAGE_HANDLER = null;

// The library's typings omit props its component accepts.
type MarkdownRendererProps = MarkdownProps & {
  children: string;
  topLevelMaxExceededItem?: React.ReactNode;
  allowedImageHandlers?: string[];
  defaultImageHandler?: string | null;
};
const MarkdownRenderer = Markdown as unknown as React.ComponentType<MarkdownRendererProps>;

/**
 * iOS Text Selection Modal
 * Opens on double-tap to allow text selection from raw content
 * Uses BottomSheetModal for consistent styling with rest of app
 */
interface TextSelectionModalProps {
  sheetRef: React.RefObject<BottomSheetModal | null>;
  text: string;
  isDark: boolean;
  onDismiss: () => void;
}

function TextSelectionModal({ sheetRef, text, isDark, onDismiss }: TextSelectionModalProps) {
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => ['70%', '95%'], []);
  const [copied, setCopied] = useState(false);
  const [currentSnapIndex, setCurrentSnapIndex] = useState(0);
  const { height: screenHeight } = useWindowDimensions();
  
  // Calculate available height based on current snap point
  const snapPercent = currentSnapIndex === 1 ? 0.95 : 0.70;
  const textInputHeight = screenHeight * snapPercent - 100 - insets.bottom;

  const handleSheetChange = useCallback((index: number) => {
    if (index >= 0) {
      setCurrentSnapIndex(index);
    }
  }, []);

  const colors = {
    bg: isDark ? THEME.dark.background : THEME.light.background,
    text: isDark ? THEME.dark.foreground : THEME.light.foreground,
    muted: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground,
    card: isDark ? THEME.dark.card : THEME.light.card,
  };


  const handleCopyAll = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy:', err);
    }
  }, [text]);

  return (
    <KortixBottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      index={0}
      enablePanDownToClose
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={onDismiss}
      style={{
        zIndex: 999,
        elevation: Platform.OS === 'android' ? 50 : undefined,
      }}
    >
      <BottomSheetView style={{ flex: 1 }}>
        {/* Header - fixed at top */}
        <View style={[drawerStyles.header, { paddingHorizontal: 24 }]}>
          <RNText style={[drawerStyles.title, { color: colors.text }]}>
            Select Text
          </RNText>
          <BottomSheetTouchable 
            onPress={handleCopyAll} 
            style={[drawerStyles.copyButton, { 
              backgroundColor: 'transparent',
              borderColor: isDark ? THEME.dark.border : THEME.light.border,
            }]}
          >
            <Copy size={16} color={colors.text} />
            <RNText style={[drawerStyles.copyButtonText, { color: colors.text }]}>
              {copied ? 'Copied!' : 'Copy All'}
            </RNText>
          </BottomSheetTouchable>
        </View>

        {/* Hint */}
        <RNText style={[drawerStyles.hint, { color: colors.muted, paddingHorizontal: 24 }]}>
          Tap and hold text to select
        </RNText>

        {/* Scrollable + selectable using Expensify MarkdownTextInput */}
        <View style={{ paddingHorizontal: 24 }}>
          <MarkdownTextInput
            value={text}
            onChangeText={() => {}}
            parser={markdownParser}
            markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
            editable={false}
            multiline={true}
            scrollEnabled={true}
            style={[
              drawerStyles.textContent, 
              { 
                height: textInputHeight,
                color: colors.text,
                textAlignVertical: 'top',
              }
            ]}
          />
        </View>
      </BottomSheetView>
    </KortixBottomSheetModal>
  );
}

const drawerStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Roobert-SemiBold',
  },
  hint: {
    fontSize: 13,
    fontFamily: 'Roobert-Regular',
    marginBottom: 16,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  copyButtonText: {
    fontSize: 14,
    fontFamily: 'Roobert-Medium',
  },
  textContent: {
    fontSize: 16,
    lineHeight: 26,
    fontFamily: 'Roobert-Regular',
  },
});


/**
 * An open fence at the end of a message highlights once its text has not
 * changed for this long, when the caller does not say whether it streams.
 */
const OPEN_FENCE_SETTLE_MS = 1000;

/**
 * Whether the open fence at the end of `text` is still growing.
 * `isStreaming` decides when given; otherwise the fence counts as growing until
 * `text` stays unchanged for `OPEN_FENCE_SETTLE_MS`.
 */
function useFenceStillGrowing(text: string, endsInOpenFence: boolean, isStreaming: boolean | undefined) {
  const [settledText, setSettledText] = useState<string | null>(null);
  const useTimer = endsInOpenFence && isStreaming === undefined;
  useEffect(() => {
    if (!useTimer) return;
    const timer = setTimeout(() => setSettledText(text), OPEN_FENCE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text, useTimer]);
  if (!endsInOpenFence) return false;
  if (isStreaming !== undefined) return isStreaming;
  return settledText !== text;
}

/**
 * A block that arrives while the message streams fades up into place — web's
 * `stream-fade-in` intent. Opacity plus a 4pt rise, 200ms, the app's ease-out.
 * Reanimated skips it under the system reduce-motion setting.
 */
const BLOCK_ENTERING = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 4 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: Easing.bezier(...MOTION.easing.out) },
}).duration(MOTION.duration.moderate);

/**
 * One top-level markdown block. Memoized on its props, so a block that did not
 * change while a message streams skips parsing and keeps its native views.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  isDark,
  openFence,
  marginTop,
  animate,
}: {
  text: string;
  isDark: boolean;
  /** This block ends in a fence that is still streaming. */
  openFence: boolean;
  marginTop: number;
  animate: boolean;
}) {
  const content = isMarkdownSeparatorBlock(text) ? (
    <MarkdownRule palette={markdownPalette(isDark)} />
  ) : (
    <OpenFenceContext.Provider value={openFence}>
      <MarkdownRenderer
        style={isDark ? DARK_MARKDOWN_STYLES : LIGHT_MARKDOWN_STYLES}
        rules={isDark ? DARK_MARKDOWN_RULES : LIGHT_MARKDOWN_RULES}
        mergeStyle={true}
        markdownit={MARKDOWN_IT}
        onLinkPress={handleLibraryLinkPress}
        topLevelMaxExceededItem={TOP_LEVEL_MAX_EXCEEDED_ITEM}
        allowedImageHandlers={ALLOWED_IMAGE_HANDLERS}
        defaultImageHandler={DEFAULT_IMAGE_HANDLER}
      >
        {text}
      </MarkdownRenderer>
    </OpenFenceContext.Provider>
  );
  return (
    <Animated.View entering={animate ? BLOCK_ENTERING : undefined} style={marginTop ? { marginTop } : undefined}>
      {content}
    </Animated.View>
  );
});

type BlockKinds = { first: BlockKind; last: BlockKind };

function blockKinds(block: string): BlockKinds {
  return isMarkdownSeparatorBlock(block) ? { first: 'hr', last: 'hr' } : classifyBlock(block);
}

function MarkdownBlocks({ text, isDark, isStreaming }: { text: string; isDark: boolean; isStreaming?: boolean }) {
  const { blocks, endsInOpenFence } = useMemo(() => splitMarkdown(prepareMarkdownForMath(text)), [text]);
  const fenceGrowing = useFenceStillGrowing(text, endsInOpenFence, isStreaming);

  // Blocks present on the first render (history, a remount, a recycled row)
  // appear at once; only blocks that arrive afterwards animate in. Text that is
  // not an extension of the previous text is a different message: reset.
  const firstCount = useRef<number | null>(null);
  const previousText = useRef(text);
  if (firstCount.current === null || !text.startsWith(previousText.current)) {
    firstCount.current = blocks.length;
  }
  previousText.current = text;

  // `classifyBlock` reads only a block's first and last lines, so this costs
  // little per block however long the message grows.
  const kinds = useMemo(() => blocks.map(blockKinds), [blocks]);

  // A run of image-only blocks with two or more images is one swipeable
  // gallery; every other block renders as markdown.
  const items = useMemo(() => groupImageBlocks(blocks), [blocks]);

  return (
    <View>
      {items.map((item, itemIndex) => {
        // Position is the identity: streaming only appends, so block N stays
        // block N, and a gallery keeps the index of its first block.
        const index = item.index;
        const previous = itemIndex === 0 ? null : items[itemIndex - 1];
        const previousLast = previous ? (previous.kind === 'gallery' ? previous.last : previous.index) : null;
        const marginTop = collapsedGap(previousLast === null ? null : kinds[previousLast].last, kinds[index].first);
        if (item.kind === 'gallery') {
          return (
            <View key={index} style={marginTop ? { marginTop } : undefined}>
              <MarkdownImageGallery images={item.images} isDark={isDark} />
            </View>
          );
        }
        return (
          <MarkdownBlock
            key={index}
            text={item.text}
            isDark={isDark}
            openFence={fenceGrowing && index === blocks.length - 1}
            marginTop={marginTop}
            animate={index >= (firstCount.current ?? 0)}
          />
        );
      })}
    </View>
  );
}

const DOUBLE_TAP_DELAY_MS = 300;

function noop() {}

/**
 * iOS binary without `RNUITextView` only: a double tap opens the selection sheet. The sheet mounts on the first
 * double tap, not with every text part, and stays mounted after dismiss.
 * `Pressable` is deliberate, NOT `Button`: this is a gesture target over body
 * text, so it must have no press animation at all.
 */
function IOSSelectableMarkdown({ text, isDark, isStreaming }: { text: string; isDark: boolean; isStreaming?: boolean }) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const lastTapRef = useRef(0);
  const presentOnMountRef = useRef(false);
  const [sheetMounted, setSheetMounted] = useState(false);

  useEffect(() => {
    if (sheetMounted && presentOnMountRef.current) {
      presentOnMountRef.current = false;
      bottomSheetRef.current?.present();
    }
  }, [sheetMounted]);

  const handlePress = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current >= DOUBLE_TAP_DELAY_MS) {
      lastTapRef.current = now;
      return;
    }
    lastTapRef.current = 0;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (sheetMounted) {
      bottomSheetRef.current?.present();
    } else {
      presentOnMountRef.current = true;
      setSheetMounted(true);
    }
  }, [sheetMounted]);

  return (
    <>
      <Pressable onPress={handlePress}>
        <MarkdownBlocks text={text} isDark={isDark} isStreaming={isStreaming} />
      </Pressable>
      {sheetMounted ? (
        <TextSelectionModal sheetRef={bottomSheetRef} text={text} isDark={isDark} onDismiss={noop} />
      ) : null}
    </>
  );
}

/**
 * SelectableMarkdownText
 *
 * Renders markdown with natively selectable text. On an iOS binary without
 * the `UITextView` native view, a double tap opens a selection sheet instead.
 */
export const SelectableMarkdownText: React.FC<SelectableMarkdownTextProps> = memo(
  function SelectableMarkdownText({ children, isDark: isDarkProp, isStreaming, remoteImages = 'placeholder', surface }: SelectableMarkdownTextProps) {
    const { colorScheme } = useColorScheme();
    const isDark = isDarkProp ?? colorScheme === 'dark';

    // Trailing whitespace would add empty space below the last block.
    const text = typeof children === 'string' ? children.trimEnd() : String(children || '').trimEnd();

    return (
      <MarkdownImagesContext.Provider value={remoteImages}>
        <MarkdownSurfaceContext.Provider value={surface}>
          {Platform.OS === 'ios' && !IOS_TEXT_VIEW ? (
            <IOSSelectableMarkdown text={text} isDark={isDark} isStreaming={isStreaming} />
          ) : (
            <MarkdownBlocks text={text} isDark={isDark} isStreaming={isStreaming} />
          )}
        </MarkdownSurfaceContext.Provider>
      </MarkdownImagesContext.Provider>
    );
  },
);
