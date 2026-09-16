/**
 * SelectableMarkdownText
 *
 * Renders chat markdown with react-native-markdown-display. On Android the text
 * is natively selectable; on iOS a double tap opens a sheet with the raw text.
 *
 * Streaming: the text is split into top-level blocks (`splitMarkdownBlocks`),
 * and each block renders in its own memoized component keyed by its position.
 * When a message grows, only the last block's string changes, so completed
 * blocks are neither re-parsed nor remounted.
 *
 * Untrusted content: message markdown comes from the agent. Links open only for
 * http(s) and mailto, and images are never fetched; they render as a
 * placeholder that opens the source in the browser on tap.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  TextStyle,
  View,
  Text as RNText,
  Pressable,
  LogBox,
  Platform,
  Dimensions,
  Linking,
} from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import Markdown, { MarkdownIt, type MarkdownProps } from 'react-native-markdown-display';
import { BottomSheetModal, BottomSheetView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { CopyIcon as Copy, ImageIcon } from '@/lib/icons';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/utils/theme';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { log } from '@/lib/logger';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { isMarkdownSeparatorBlock, splitMarkdownBlocks } from '@/lib/markdown/split-blocks';
import { isSafeExternalLink } from '@/lib/markdown/safe-link';
import { describeMarkdownImage } from '@/lib/markdown/markdown-image';

// Suppress known warning from react-native-markdown-display library
LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);

/**
 * LINE HEIGHT CONFIGURATION
 * Increased for better readability - text was too crowded
 */
const MARKDOWN_LINE_HEIGHT = 23; // matches user bubble (text-sm leading-relaxed)
const MARKDOWN_FONT_SIZE = 14;

export interface SelectableMarkdownTextProps {
  /** The markdown text content to render */
  children: string;
  /** Accepted for compatibility; the markdown renderer does not apply it. */
  style?: TextStyle;
  /** Whether to use dark mode (if not provided, will use color scheme hook) */
  isDark?: boolean;
}

/**
 * Opens a link from message markdown when its scheme is http(s) or mailto.
 * Any other scheme is ignored, and a failed open never becomes an unhandled
 * rejection.
 */
function openExternalLink(href: unknown) {
  if (!isSafeExternalLink(href)) return;
  Linking.openURL(href.trim()).catch(() => {});
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
 * Stand-in for a markdown image. Remote images are not loaded: a URL can leak
 * data to its host on render, and a huge image can exhaust memory on decode.
 * An http(s) source opens in the browser on tap; data: and other sources only
 * show the label.
 */
function MarkdownImagePlaceholder({ src, alt }: { src: unknown; alt: unknown }) {
  const { label, href } = describeMarkdownImage(src, alt);
  return (
    <Button
      variant="secondary"
      size="sm"
      className="my-1 max-w-full self-start"
      disabled={!href}
      onPress={href ? () => openExternalLink(href) : undefined}
      role={href ? 'link' : 'img'}
      accessibilityLabel={`Image: ${label}`}
    >
      <Icon as={ImageIcon} size={16} />
      <Text numberOfLines={1} className="shrink">
        {label}
      </Text>
    </Button>
  );
}

/**
 * ANDROID-SPECIFIC: Custom render rules for react-native-markdown-display
 * Makes all text components selectable for proper text selection on Android
 */
const createAndroidMarkdownRules = (isDark: boolean) => ({
  // Make all text selectable
  text: (node: any, children: any, parent: any, styles: any, inheritedStyles: any = {}) => (
    <RNText 
      key={node.key} 
      style={[inheritedStyles, styles.text]}
      selectable={true}
    >
      {node.content}
    </RNText>
  ),
  // Wrap textgroup with selectable
  textgroup: (node: any, children: any, parent: any, styles: any) => (
    <RNText key={node.key} style={styles.textgroup} selectable={true}>
      {children}
    </RNText>
  ),
  // Paragraph - keep View but children will be selectable
  paragraph: (node: any, children: any, parent: any, styles: any) => (
    <View key={node.key} style={styles.paragraph}>
      {children}
    </View>
  ),
  // Strong/bold text
  strong: (node: any, children: any, parent: any, styles: any) => (
    <RNText key={node.key} style={styles.strong} selectable={true}>
      {children}
    </RNText>
  ),
  // Italic text
  em: (node: any, children: any, parent: any, styles: any) => (
    <RNText key={node.key} style={styles.em} selectable={true}>
      {children}
    </RNText>
  ),
  // Strikethrough
  s: (node: any, children: any, parent: any, styles: any) => (
    <RNText key={node.key} style={styles.s} selectable={true}>
      {children}
    </RNText>
  ),
  // Links - selectable and pressable; only http(s) and mailto open
  link: (node: any, children: any, parent: any, styles: any) => (
    <RNText
      key={node.key}
      style={[styles.link, { color: THEME.accent.blue }]}
      selectable={true}
      onPress={() => openExternalLink(node.attributes?.href)}
    >
      {children}
    </RNText>
  ),
  // Images - never fetched; a placeholder instead
  image: (node: any) => (
    <MarkdownImagePlaceholder key={node.key} src={node.attributes?.src} alt={node.attributes?.alt} />
  ),
  // Inline code
  code_inline: (node: any, children: any, parent: any, styles: any) => (
    <RNText 
      key={node.key} 
      style={[styles.code_inline, { 
        backgroundColor: isDark ? THEME.dark.muted : THEME.light.muted,
        color: isDark ? THEME.dark.destructive : THEME.light.destructive,
      }]}
      selectable={true}
    >
      {node.content}
    </RNText>
  ),
  // Headings
  heading1: (node: any, children: any, parent: any, styles: any) => (
    <View key={node.key} style={styles.heading1}>
      <RNText style={[styles.heading1, { fontSize: 26, fontFamily: 'Roobert-Bold' }]} selectable={true}>
        {children}
      </RNText>
    </View>
  ),
  heading2: (node: any, children: any, parent: any, styles: any) => (
    <View key={node.key} style={styles.heading2}>
      <RNText style={[styles.heading2, { fontSize: 22, fontFamily: 'Roobert-Bold' }]} selectable={true}>
        {children}
      </RNText>
    </View>
  ),
  heading3: (node: any, children: any, parent: any, styles: any) => (
    <View key={node.key} style={styles.heading3}>
      <RNText style={[styles.heading3, { fontSize: 18, fontFamily: 'Roobert-SemiBold' }]} selectable={true}>
        {children}
      </RNText>
    </View>
  ),
  // Table - renders entire table from AST with coordinated column widths
  table: (node: any, _children: any, parent: any, styles: any) => {
    // Extract plain text from an AST node recursively
    const extractText = (n: any): string => {
      if (!n) return '';
      if (n.content) return n.content;
      if (!n.children) return '';
      return n.children.map((c: any) => extractText(c)).join('');
    };

    // Render inline content from a cell AST node (supports bold, italic, code, links)
    const renderCellContent = (cellNode: any, isHeader: boolean): React.ReactNode => {
      const inlineNodes = cellNode.children || [];
      // Cells often have a single wrapper node containing the actual content
      const nodes = inlineNodes.length === 1 && inlineNodes[0].children
        ? inlineNodes[0].children
        : inlineNodes;

      if (nodes.length === 0) return extractText(cellNode);

      return nodes.map((n: any, i: number) => {
        if (n.type === 'text') return n.content || '';
        if (n.type === 'softbreak') return '\n';
        if (n.type === 'strong') {
          return (
            <RNText key={i} style={{ fontFamily: 'Roobert-SemiBold' }}>
              {extractText(n)}
            </RNText>
          );
        }
        if (n.type === 'em') {
          return (
            <RNText key={i} style={{ fontStyle: 'italic' }}>
              {extractText(n)}
            </RNText>
          );
        }
        if (n.type === 's') {
          return (
            <RNText key={i} style={{ textDecorationLine: 'line-through' }}>
              {extractText(n)}
            </RNText>
          );
        }
        if (n.type === 'code_inline') {
          return (
            <RNText key={i} style={{
              fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
              fontSize: isHeader ? 10 : 12,
              backgroundColor: isDark ? THEME.dark.muted : THEME.light.muted,
              color: isDark ? THEME.dark.destructive : THEME.light.destructive,
            }}>
              {n.content}
            </RNText>
          );
        }
        if (n.type === 'link') {
          return (
            <RNText key={i} style={{ color: THEME.accent.blue }}
              onPress={() => openExternalLink(n.attributes?.href)}
            >
              {extractText(n)}
            </RNText>
          );
        }
        return extractText(n);
      });
    };

    // Parse table structure from AST: table > thead/tbody > tr > th/td
    const sections: { isHeader: boolean; rows: any[][] }[] = [];
    for (const section of (node.children || [])) {
      const isHeader = section.type === 'thead';
      const rows: any[][] = [];
      for (const row of (section.children || [])) {
        if (row.type === 'tr') {
          const cells = (row.children || []).filter((c: any) => c.type === 'th' || c.type === 'td');
          rows.push(cells);
        }
      }
      if (rows.length > 0) sections.push({ isHeader, rows });
    }

    // Compute column count
    const colCount = Math.max(0, ...sections.flatMap(s => s.rows.map(r => r.length)));
    if (colCount === 0) return <View key={node.key} />;

    // Compute max text length per column, then estimate pixel width
    const colWidths: number[] = [];
    for (let col = 0; col < colCount; col++) {
      let maxLen = 0;
      for (const section of sections) {
        for (const row of section.rows) {
          if (col < row.length) {
            const text = extractText(row[col]);
            maxLen = Math.max(maxLen, text.length);
          }
        }
      }
      // ~7.5px per char at 13px Roobert font + 20px horizontal padding, min 44px
      colWidths.push(Math.max(maxLen * 7.5 + 20, 44));
    }

    const borderColor = isDark ? THEME.dark.border : THEME.light.border;

    return (
      <View
        key={node.key}
        style={{
          marginVertical: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor,
          overflow: 'hidden',
        }}
      >
        <GHScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            {sections.map((section, sIdx) =>
              section.rows.map((cells, rIdx) => (
                <View
                  key={`${sIdx}-${rIdx}`}
                  style={{
                    flexDirection: 'row',
                    borderBottomWidth: 1,
                    borderBottomColor: borderColor,
                    ...(section.isHeader ? { backgroundColor: isDark ? THEME.dark.muted : THEME.light.muted } : {}),
                  }}
                >
                  {cells.map((cell: any, cIdx: number) => (
                    <View
                      key={cIdx}
                      style={{
                        width: colWidths[cIdx],
                        paddingVertical: section.isHeader ? 6 : 8,
                        paddingHorizontal: 10,
                      }}
                    >
                      <RNText
                        style={{
                          fontFamily: section.isHeader ? 'Roobert-SemiBold' : 'Roobert-Regular',
                          fontSize: section.isHeader ? 11 : 13,
                          lineHeight: section.isHeader ? undefined : 17,
                          letterSpacing: section.isHeader ? 0.3 : undefined,
                          color: section.isHeader
                            ? (isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground)
                            : (isDark ? THEME.dark.foreground : THEME.light.foreground),
                          textAlign: 'left',
                        }}
                        selectable
                      >
                        {renderCellContent(cell, section.isHeader)}
                      </RNText>
                    </View>
                  ))}
                </View>
              ))
            )}
          </View>
        </GHScrollView>
      </View>
    );
  },
});

/**
 * Android markdown styles for react-native-markdown-display
 */
const createAndroidMarkdownStyles = (isDark: boolean) => StyleSheet.create({
  body: {
    color: isDark ? THEME.dark.foreground : THEME.light.foreground,
    fontSize: MARKDOWN_FONT_SIZE,
    lineHeight: MARKDOWN_LINE_HEIGHT,
    fontFamily: 'Roobert-Regular',
  },
  text: {
    color: isDark ? THEME.dark.foreground : THEME.light.foreground,
    // Don't set fontFamily here - let it inherit from parent (strong, em, etc.)
  },
  textgroup: {
    color: isDark ? THEME.dark.foreground : THEME.light.foreground,
    // Don't set fontFamily here - let children inherit from their specific styles (strong, em, etc.)
  },
  paragraph: {
    marginVertical: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  strong: {
    fontFamily: 'Roobert-SemiBold',
    fontWeight: '600',
  },
  em: {
    fontStyle: 'italic',
    fontFamily: 'Roobert-Regular',
  },
  s: {
    textDecorationLine: 'line-through',
  },
  link: {
    textDecorationLine: 'none',
  },
  code_inline: {
    fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
    fontSize: 14,
    paddingHorizontal: 4,
    borderRadius: 4,
    backgroundColor: isDark ? THEME.dark.muted : THEME.light.muted,
    color: isDark ? THEME.dark.destructive : THEME.light.destructive,
  },
  // Fenced/indented code sits on `card`, one step darker than the `muted`
  // inline-code chip, so a fence stays distinguishable from inline code.
  fence: {
    backgroundColor: isDark ? THEME.dark.card : THEME.light.card,
    borderRadius: 8,
    padding: 12,
  },
  code_block: {
    backgroundColor: isDark ? THEME.dark.card : THEME.light.card,
    borderRadius: 8,
    padding: 12,
    fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
    fontSize: 14,
  },
  heading1: {
    fontSize: 26,
    fontFamily: 'Roobert-Bold',
    marginVertical: 4,
  },
  heading2: {
    fontSize: 22,
    fontFamily: 'Roobert-Bold',
    marginVertical: 4,
  },
  heading3: {
    fontSize: 18,
    fontFamily: 'Roobert-SemiBold',
    marginVertical: 4,
  },
  blockquote: {
    borderLeftWidth: 4,
    borderLeftColor: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground,
    paddingLeft: 12,
    marginLeft: 0,
    backgroundColor: 'transparent',
  },
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  list_item: {
    flexDirection: 'row',
    marginVertical: 2,
  },
  hr: {
    height: 1,
    backgroundColor: isDark ? THEME.dark.border : THEME.light.border,
    marginVertical: 12,
  },
  // Table styles - proper column widths
  table: {
    borderWidth: 0,
  },
  thead: {
    backgroundColor: isDark ? THEME.dark.muted : THEME.light.muted,
  },
  tbody: {
    backgroundColor: 'transparent',
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: isDark ? THEME.dark.border : THEME.light.border,
  },
  th: {
    width: 140,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: 'Roobert-SemiBold',
    fontWeight: '600',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: isDark ? THEME.dark.foreground : THEME.light.foreground,
    textAlign: 'left',
  },
  td: {
    width: 140,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: 'Roobert-Regular',
    fontSize: 14,
    color: isDark ? THEME.dark.foreground : THEME.light.foreground,
    textAlign: 'left',
  },
});

// react-native-markdown-display rebuilds its renderer (StyleSheet.create over
// every style key) whenever one of these props changes identity, and its
// defaults are new objects on every render. Module-level values keep one
// renderer per theme and one markdown-it instance.
const MARKDOWN_IT = MarkdownIt({ typographer: true });
const LIGHT_MARKDOWN_RULES = createAndroidMarkdownRules(false);
const DARK_MARKDOWN_RULES = createAndroidMarkdownRules(true);
const LIGHT_MARKDOWN_STYLES = createAndroidMarkdownStyles(false);
const DARK_MARKDOWN_STYLES = createAndroidMarkdownStyles(true);
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
  const sheetBg = useSheetBackground();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => ['70%', '95%'], []);
  const [copied, setCopied] = useState(false);
  const [currentSnapIndex, setCurrentSnapIndex] = useState(0);
  const screenHeight = Dimensions.get('window').height;
  
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
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      index={0}
      enablePanDownToClose
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={onDismiss}
      backdropComponent={SheetBackdrop}
      backgroundStyle={{
        backgroundColor: sheetBg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
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
    </BottomSheetModal>
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
 * Simple horizontal separator
 */
function Separator({ isDark }: { isDark: boolean }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: isDark ? THEME.dark.border : THEME.light.border,
        marginVertical: 8,
      }}
    />
  );
}

/**
 * One top-level markdown block. Memoized on its string, so a block that did not
 * change while a message streams skips parsing and keeps its native views.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text, isDark }: { text: string; isDark: boolean }) {
  if (isMarkdownSeparatorBlock(text)) return <Separator isDark={isDark} />;
  return (
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
  );
});

function MarkdownBlocks({ text, isDark }: { text: string; isDark: boolean }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <View>
      {blocks.map((block, index) => (
        // Position is the identity: streaming only appends, so block N stays block N.
        <MarkdownBlock key={index} text={block} isDark={isDark} />
      ))}
    </View>
  );
}

const DOUBLE_TAP_DELAY_MS = 300;

function noop() {}

/**
 * iOS: a double tap opens the selection sheet. The sheet mounts on the first
 * double tap, not with every text part, and stays mounted after dismiss.
 * `Pressable` is deliberate, NOT `Button`: this is a gesture target over body
 * text, so it must have no press animation at all.
 */
function IOSSelectableMarkdown({ text, isDark }: { text: string; isDark: boolean }) {
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
        <MarkdownBlocks text={text} isDark={isDark} />
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
 * Renders markdown with selectable text: natively on Android, through a
 * double-tap selection sheet on iOS.
 */
export const SelectableMarkdownText: React.FC<SelectableMarkdownTextProps> = memo(
  function SelectableMarkdownText({ children, isDark: isDarkProp }: SelectableMarkdownTextProps) {
    const { colorScheme } = useColorScheme();
    const isDark = isDarkProp ?? colorScheme === 'dark';

    // Trailing whitespace would add empty space below the last block.
    const text = typeof children === 'string' ? children.trimEnd() : String(children || '').trimEnd();

    if (Platform.OS === 'ios') {
      return <IOSSelectableMarkdown text={text} isDark={isDark} />;
    }
    return <MarkdownBlocks text={text} isDark={isDark} />;
  },
);
