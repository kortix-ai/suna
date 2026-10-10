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
 * ```openui fences (`openui-lang`, `openui-vN`) render as generative UI
 * (`components/genui/genui-message-block.tsx`).
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

import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  TextStyle,
  View,
  Text as RNText,
  LogBox,
  Platform,
  type TextProps,
} from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import Markdown, { MarkdownIt, type MarkdownProps } from 'react-native-markdown-display';
import { useColorScheme } from 'nativewind';
import { MOTION } from '@/lib/utils/theme';
import { FONT_FAMILY } from '@/lib/utils/fonts';
import { Text } from '@/components/ui/text';
import { isMathFenceLanguage, isMermaidCode, prepareMarkdownForMath } from '@kortix/shared';
import { genuiVersionOf, separateGenuiClosers } from '@kortix/sdk/genui/fence';
import { CodeBlock, fenceCode, fenceLanguage } from '@/components/markdown/code-block';
import { InlineCode } from '@/components/markdown/inline-code';
import { BlockMath, InlineMath } from '@/components/markdown/math';
import { MermaidBlock } from '@/components/markdown/mermaid/MermaidBlock';
import { mathPlugin } from '@/lib/markdown/math-plugin';
import { markdownPalette, type MarkdownPalette } from '@/components/markdown/markdown-theme';
import { isMarkdownSeparatorBlock, splitMarkdown } from '@/lib/markdown/split-blocks';
import { groupImageBlocks, imageSourceKey } from '@/lib/markdown/markdown-image';
import { MarkdownImage, MarkdownImageGallery, MarkdownImagesContext, type MarkdownRemoteImages } from '@/components/markdown/markdown-image';
import {
  classifyBlock,
  collapsedGap,
  kindOfNode,
  orderedListGutter,
  TYPE,
  web,
  type BlockKind,
  type StackContext,
} from '@/lib/markdown/markdown-layout';
import {
  MarkdownText,
  openExternalLink,
  IOS_TEXT_VIEW,
} from '@/components/markdown/markdown-text';
import {
  MarkdownTable,
  MarkdownSurfaceContext,
  type AstNode,
} from '@/components/markdown/markdown-table';
import { IOSSelectableMarkdown } from '@/components/markdown/ios-selection-fallback';
import { GenuiMessageBlock } from '@/components/genui/genui-message-block';


// Suppress known warning from react-native-markdown-display library
LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);


function noop() {}

/**
 * Android: a selectable text node with no press handler of its own never
 * delivers a tap to a nested link (KRTX-562). A no-op handler on the outer node
 * restores the link's `onPress` and keeps native selection (verified on a
 * Pixel 9 emulator, RN 0.85). `accessibilityRole="text"` keeps the handler
 * from announcing every paragraph as a link.
 */
const ANDROID_LINK_TAPS: Partial<TextProps> =
  Platform.OS === 'android' ? { onPress: noop, accessibilityRole: 'text' } : {};

interface SelectableMarkdownTextProps {
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

/**
 * false inside a generative-UI fallback: an ```openui fence there renders as
 * code, so a fallback can never re-enter `GenuiBlock`, and the fallback adds
 * no second iOS selection Pressable inside the message's own.
 */
const GenuiRoutingContext = createContext(true);

/**
 * A generative-UI block's markdown fallback, under the message's remote-image
 * policy. `GenuiBlock` needs a stable renderer, so there is one per theme.
 */
function GenuiFallback({ markdown, isDark }: { markdown: string; isDark: boolean }) {
  const remoteImages = useContext(MarkdownImagesContext);
  return (
    <GenuiRoutingContext.Provider value={false}>
      <SelectableMarkdownText isDark={isDark} remoteImages={remoteImages}>
        {markdown}
      </SelectableMarkdownText>
    </GenuiRoutingContext.Provider>
  );
}
const genuiFallback = (isDark: boolean) => (markdown: string) =>
  markdown ? <GenuiFallback markdown={markdown} isDark={isDark} /> : null;
const GENUI_FALLBACK_LIGHT = genuiFallback(false);
const GENUI_FALLBACK_DARK = genuiFallback(true);

/** Web's `MarkdownCode` routing: generative UI, then Mermaid, then math fences, then code. */
function FencedCode({ node, isDark }: { node: AstNode; isDark: boolean }) {
  const isStreaming = useContext(OpenFenceContext);
  const routeGenui = useContext(GenuiRoutingContext);
  // The raw first word of the info string: `fenceLanguage` may normalize `openui-lang` away.
  const genuiVersion = routeGenui ? genuiVersionOf((node.sourceInfo ?? '').trim().split(/\s+/)[0] ?? '') : null;
  if (genuiVersion !== null) {
    return (
      <GenuiMessageBlock
        code={fenceCode(node.content)}
        version={genuiVersion}
        isStreaming={isStreaming}
        renderMarkdown={isDark ? GENUI_FALLBACK_DARK : GENUI_FALLBACK_LIGHT}
      />
    );
  }
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
    // A generative-UI fallback sits inside its message: the message's double tap covers it.
    const isOutermost = useContext(GenuiRoutingContext);

    // Trailing whitespace would add empty space below the last block. A closer the model glued to the
    // last statement of a generative-UI block moves to its own line, so the block ends where it should.
    const text = separateGenuiClosers(typeof children === 'string' ? children.trimEnd() : String(children || '').trimEnd());

    return (
      <MarkdownImagesContext.Provider value={remoteImages}>
        <MarkdownSurfaceContext.Provider value={surface}>
          {Platform.OS === 'ios' && !IOS_TEXT_VIEW && isOutermost ? (
            <IOSSelectableMarkdown text={text} isDark={isDark} isStreaming={isStreaming}>
              <MarkdownBlocks text={text} isDark={isDark} isStreaming={isStreaming} />
            </IOSSelectableMarkdown>
          ) : (
            <MarkdownBlocks text={text} isDark={isDark} isStreaming={isStreaming} />
          )}
        </MarkdownSurfaceContext.Provider>
      </MarkdownImagesContext.Provider>
    );
  },
);
