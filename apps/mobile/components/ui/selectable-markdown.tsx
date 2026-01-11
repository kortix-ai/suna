/**
 * SelectableMarkdownText Component
 *
 * A wrapper around MarkdownTextInput that provides selectable markdown text
 * with proper styling using @expensify/react-native-live-markdown.
 * 
 * HEIGHT CALCULATION APPROACH:
 * Uses visual line count (including text wrapping) to calculate height instantly.
 * No onContentSizeChange = no layout shift during load.
 * 
 * Key: A single long paragraph might wrap to 5+ visual lines on screen,
 * so we estimate wrapping based on character width and screen width.
 */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  TextStyle,
  View,
  Text as RNText,
  Pressable,
  LogBox,
  Keyboard,
  Platform,
  Dimensions,
  Linking,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import Markdown from 'react-native-markdown-display';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Copy, X } from 'lucide-react-native';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { useColorScheme } from 'nativewind';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { log } from '@/lib/logger';

// Suppress known warning from react-native-markdown-display library
LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);

/**
 * LINE HEIGHT CONFIGURATION
 * Increased for better readability - text was too crowded
 */
const MARKDOWN_LINE_HEIGHT = 28; // Bumped from 26 for more breathing room
const MARKDOWN_FONT_SIZE = 16;

// Debug mode to see height calculations
let DEBUG_HEIGHTS = false;

// Config: Disable special block rendering (tables, code blocks, separators)
// When true, everything renders as plain markdown without splitting
let DISABLE_BLOCK_SPLITTING = true;

export function setBlockSplitting(enabled: boolean) {
  DISABLE_BLOCK_SPLITTING = !enabled;
  log.log(`[MD] Block splitting ${enabled ? 'enabled' : 'disabled'}`);
}

// Runtime tunable values  
// CHAR_WIDTH_FACTOR: Lower = more chars per line = fewer visual lines = shorter (less over-estimation)
let CHAR_WIDTH_FACTOR = 0.42;      // Was 0.48, reduced to prevent over-estimation on long text
let HEADING_CHAR_FACTOR = 0.46;    // Was 0.52
let EMPTY_LINE_FACTOR = 0.5;
let BOLD_WIDTH_FACTOR = 1.10;      // Was 1.15, reduced slightly

let BASE_PHANTOM = 8;
let LINE_PHANTOM_PX = 0.5;
let MAX_LINE_PHANTOM = 8;

export function enableMarkdownDebug(enabled: boolean = true) {
  DEBUG_HEIGHTS = enabled;
  log.log(`[SelectableMarkdown] Debug ${enabled ? 'enabled' : 'disabled'}`);
}

export function setCharWidthFactor(factor: number) {
  CHAR_WIDTH_FACTOR = factor;
  log.log(`[MD] Char width factor: ${factor}`);
}

export function setHeadingCharFactor(factor: number) {
  HEADING_CHAR_FACTOR = factor;
  log.log(`[MD] Heading char factor: ${factor}`);
}

export function setEmptyLineFactor(factor: number) {
  EMPTY_LINE_FACTOR = factor;
  log.log(`[MD] Empty line factor: ${factor}`);
}

export function setBasePhantom(px: number) {
  BASE_PHANTOM = px;
  log.log(`[MD] Base phantom: ${px}px`);
}

export function setLinePhantom(px: number) {
  LINE_PHANTOM_PX = px;
  log.log(`[MD] Line phantom: ${px}px per line`);
}

export function setMaxLinePhantom(px: number) {
  MAX_LINE_PHANTOM = px;
  log.log(`[MD] Max line phantom: ${px}px`);
}

export function setBoldWidthFactor(factor: number) {
  BOLD_WIDTH_FACTOR = factor;
  log.log(`[MD] Bold width factor: ${(factor * 100).toFixed(0)}%`);
}

export function getFactors() {
  return { char: CHAR_WIDTH_FACTOR, heading: HEADING_CHAR_FACTOR, empty: EMPTY_LINE_FACTOR, basePhantom: BASE_PHANTOM, linePhantom: LINE_PHANTOM_PX, maxLinePhantom: MAX_LINE_PHANTOM, bold: BOLD_WIDTH_FACTOR };
}

if (__DEV__) {
  (globalThis as any).enableMarkdownDebug = enableMarkdownDebug;
  (globalThis as any).setCharWidthFactor = setCharWidthFactor;
  (globalThis as any).setHeadingCharFactor = setHeadingCharFactor;
  (globalThis as any).setEmptyLineFactor = setEmptyLineFactor;
  (globalThis as any).setBasePhantom = setBasePhantom;
  (globalThis as any).setLinePhantom = setLinePhantom;
  (globalThis as any).setMaxLinePhantom = setMaxLinePhantom;
  (globalThis as any).setBoldWidthFactor = setBoldWidthFactor;
  (globalThis as any).getFactors = getFactors;
  log.log('[MD] Tune: setBasePhantom(16) / setLinePhantom(0.5) / setMaxLinePhantom(20)');
}


export interface SelectableMarkdownTextProps {
  /** The markdown text content to render */
  children: string;
  /** Additional style for the text input */
  style?: TextStyle;
  /** Whether to use dark mode (if not provided, will use color scheme hook) */
  isDark?: boolean;
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
  // Links - selectable and pressable
  link: (node: any, children: any, parent: any, styles: any) => (
    <RNText
      key={node.key}
      style={[styles.link, { color: isDark ? '#3b82f6' : '#2563eb' }]}
      selectable={true}
      onPress={() => {
        if (node.attributes?.href) {
          Linking.openURL(node.attributes.href);
        }
      }}
    >
      {children}
    </RNText>
  ),
  // Inline code
  code_inline: (node: any, children: any, parent: any, styles: any) => (
    <RNText 
      key={node.key} 
      style={[styles.code_inline, { 
        backgroundColor: isDark ? '#27272a' : '#f4f4f5',
        color: isDark ? '#fca5a5' : '#dc2626',
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
  // Table - horizontal scroll with rounded border (using gesture handler ScrollView)
  table: (node: any, children: any, parent: any, styles: any) => (
    <View
      key={node.key}
      style={{
        marginVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: isDark ? '#3f3f46' : '#e4e4e7',
        overflow: 'hidden',
      }}
    >
      <GHScrollView 
        horizontal={true} 
        showsHorizontalScrollIndicator={true}
      >
        <View>
          {children}
        </View>
      </GHScrollView>
    </View>
  ),
  // Table header section
  thead: (node: any, children: any, parent: any, styles: any) => (
    <View 
      key={node.key} 
      style={{ backgroundColor: isDark ? '#27272a' : '#f4f4f5' }}
    >
      {children}
    </View>
  ),
  // Table body
  tbody: (node: any, children: any, parent: any, styles: any) => (
    <View key={node.key}>
      {children}
    </View>
  ),
  // Table row - horizontal layout
  tr: (node: any, children: any, parent: any, styles: any) => (
    <View 
      key={node.key} 
      style={{
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: isDark ? '#3f3f46' : '#e4e4e7',
      }}
    >
      {children}
    </View>
  ),
  // Table header cell
  th: (node: any, children: any, parent: any, styles: any) => (
    <View 
      key={node.key} 
      style={{
        width: 140,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <RNText 
        style={{
          fontFamily: 'Roobert-SemiBold',
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: isDark ? '#fafafa' : '#18181b',
        }}
        selectable={true}
      >
        {children}
      </RNText>
    </View>
  ),
  // Table data cell
  td: (node: any, children: any, parent: any, styles: any) => (
    <View 
      key={node.key} 
      style={{
        width: 140,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <RNText 
        style={{
          fontFamily: 'Roobert-Regular',
          fontSize: 14,
          color: isDark ? '#fafafa' : '#18181b',
        }}
        selectable={true}
      >
        {children}
      </RNText>
    </View>
  ),
});

/**
 * Android markdown styles for react-native-markdown-display
 */
const createAndroidMarkdownStyles = (isDark: boolean) => StyleSheet.create({
  body: {
    color: isDark ? '#fafafa' : '#18181b',
    fontSize: MARKDOWN_FONT_SIZE,
    lineHeight: MARKDOWN_LINE_HEIGHT,
    fontFamily: 'Roobert-Regular',
  },
  text: {
    color: isDark ? '#fafafa' : '#18181b',
    // Don't set fontFamily here - let it inherit from parent (strong, em, etc.)
  },
  textgroup: {
    color: isDark ? '#fafafa' : '#18181b',
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
    backgroundColor: isDark ? '#27272a' : '#f4f4f5',
    color: isDark ? '#fca5a5' : '#dc2626',
  },
  fence: {
    backgroundColor: isDark ? '#1e1e20' : '#f4f4f5',
    borderRadius: 8,
    padding: 12,
  },
  code_block: {
    backgroundColor: isDark ? '#1e1e20' : '#f4f4f5',
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
    borderLeftColor: isDark ? '#a1a1aa' : '#71717a',
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
    backgroundColor: isDark ? '#3f3f46' : '#e4e4e7',
    marginVertical: 12,
  },
  // Table styles - proper column widths
  table: {
    borderWidth: 0,
  },
  thead: {
    backgroundColor: isDark ? '#27272a' : '#f4f4f5',
  },
  tbody: {
    backgroundColor: 'transparent',
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: isDark ? '#3f3f46' : '#e4e4e7',
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
    color: isDark ? '#fafafa' : '#18181b',
    textAlign: 'left',
  },
  td: {
    width: 140,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: 'Roobert-Regular',
    fontSize: 14,
    color: isDark ? '#fafafa' : '#18181b',
    textAlign: 'left',
  },
});

/**
 * Cross-platform markdown renderer using react-native-markdown-display
 * with selectable text support
 */
function CrossPlatformMarkdownText({
  text,
  isDark,
  style,
}: {
  text: string;
  isDark: boolean;
  style?: TextStyle;
}) {
  const rules = useMemo(() => createAndroidMarkdownRules(isDark), [isDark]);
  const markdownStyles = useMemo(() => createAndroidMarkdownStyles(isDark), [isDark]);

  return (
    <Markdown
      style={markdownStyles}
      rules={rules}
      mergeStyle={true}
    >
      {text}
    </Markdown>
  );
}

// Keep old name as alias for backwards compatibility
const AndroidMarkdownText = CrossPlatformMarkdownText;

/**
 * iOS Text Selection Modal
 * Opens on double-tap to allow text selection from raw content
 * Uses BottomSheetModal for consistent styling with rest of app
 */
interface TextSelectionModalProps {
  sheetRef: React.RefObject<BottomSheetModal>;
  text: string;
  isDark: boolean;
  onDismiss: () => void;
}

function TextSelectionModal({ sheetRef, text, isDark, onDismiss }: TextSelectionModalProps) {
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
    bg: isDark ? '#161618' : '#FFFFFF',
    text: isDark ? '#f8f8f8' : '#121215',
    muted: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
    card: isDark ? '#1e1e20' : '#f5f5f5',
  };

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

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
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colors.bg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
      }}
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
              borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
            }]}
          >
            <Copy size={16} color={colors.text} strokeWidth={2} />
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
 * Check if text contains markdown tables
 */
function hasMarkdownTable(text: string): boolean {
  return /\|.*\|[\r\n]+\|[\s:|-]+\|/.test(text);
}

/**
 * Check if text contains code blocks
 */
function hasCodeBlocks(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}


/**
 * Render a code block with copy button
 */
function CodeBlock({
  code,
  language,
  isDark,
}: {
  code: string;
  language?: string;
  isDark: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy code:', err);
    }
  };

  return (
    <View style={[styles.codeBlock, isDark ? styles.codeBlockDark : styles.codeBlockLight]}>
      <View style={[styles.codeBlockHeader, { borderBottomColor: isDark ? '#3f3f46' : '#e4e4e7' }]}>
        <RNText style={[styles.codeBlockLanguage, isDark ? styles.darkText : styles.lightText]}>
          {language || 'Code Block'}
        </RNText>
        <Pressable
          onPress={handleCopy}
          style={[styles.copyButton, isDark ? styles.copyButtonDark : styles.copyButtonLight]}>
          <RNText style={[styles.copyButtonText, isDark ? styles.darkText : styles.lightText]}>
            {copied ? 'Copied!' : 'Copy'}
          </RNText>
        </Pressable>
      </View>
      <RNText
        style={[styles.codeBlockText, isDark ? styles.darkText : styles.lightText]}
        selectable>
        {code}
      </RNText>
    </View>
  );
}

/**
 * Render a simple markdown table
 */
function SimpleTable({ text, isDark }: { text: string; isDark: boolean }) {
  const lines = text.split('\n');

  return (
    <View style={[styles.table, isDark ? styles.tableDark : styles.tableLight]}>
      {lines.map((line, idx) => {
        if (!line.includes('|')) return null;

        const cells = line.split('|').filter((cell) => cell.trim());
        const isSeparator = /^[\s:|-]+$/.test(cells[0]);

        if (isSeparator) return null;

        const isHeader = idx === 0;

        return (
          <View
            key={idx}
            style={[styles.tableRow, isDark ? styles.tableRowDark : styles.tableRowLight]}>
            {cells.map((cell, cellIdx) => (
              <View
                key={cellIdx}
                style={[
                  styles.tableCell,
                  isDark ? styles.tableCellDark : styles.tableCellLight,
                  isHeader && styles.tableHeaderCell,
                  isHeader && (isDark ? styles.tableHeaderCellDark : styles.tableHeaderCellLight),
                ]}>
                <RNText
                  style={[
                    styles.tableCellText,
                    isDark ? styles.darkText : styles.lightText,
                    isHeader && styles.tableHeaderText,
                  ]}
                  selectable>
                  {cell.trim()}
                </RNText>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Check if text contains a horizontal rule separator
 */
function hasSeparator(text: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})$/m.test(text);
}

/**
 * Check if a line is a separator
 */
function isSeparatorLine(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

/**
 * Split text into blocks - only by separators
 * Don't split by links - let the markdown renderer handle them naturally
 * IMPORTANT: Trim blocks to remove leading/trailing newlines that cause extra height
 */
function splitIntoBlocks(
  text: string
): Array<{ type: 'separator' | 'text'; content: string }> {
  const lines = text.split('\n');
  const blocks: Array<{ type: 'separator' | 'text'; content: string }> = [];

  let currentBlock: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a separator line
    if (isSeparatorLine(line)) {
      // Flush current block - TRIM to remove extra newlines
      if (currentBlock.length > 0) {
        const content = currentBlock.join('\n').trim();
        if (content) {
          blocks.push({
            type: 'text',
            content,
          });
        }
        currentBlock = [];
      }
      // Add separator as its own block
      blocks.push({
        type: 'separator',
        content: line,
      });
      continue;
    }

    currentBlock.push(line);
  }

  // Flush remaining block - TRIM to remove extra newlines
  if (currentBlock.length > 0) {
    const content = currentBlock.join('\n').trim();
    if (content) {
      blocks.push({
        type: 'text',
        content,
      });
    }
  }

  return blocks;
}

/**
 * Simple horizontal separator
 */
function Separator({ isDark }: { isDark: boolean }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: isDark ? '#3f3f46' : '#e4e4e7',
        marginVertical: 8,
      }}
    />
  );
}

/**
 * Count content characteristics for debugging
 */
function analyzeContent(text: string): { lines: number; headings: number } {
  const lines = text.split('\n').length;
  const headingMatches = text.match(/^#{1,6}\s/gm);
  const headings = headingMatches ? headingMatches.length : 0;
  return { lines, headings };
}


/**
 * CALCULATED HEIGHT - NO MEASUREMENT, NO SHIFTING
 * 
 * Calculate the ACTUAL height needed based on visual line count.
 * Set container height directly = actually removes phantom space.
 * 
 * The target height IS the realHeight (visual lines × line height).
 */

/**
 * Calculate real height based on visual lines (including text wrapping)
 * 
 * Key insight from user feedback:
 * - Char width was too large (0.5) causing over-estimation
 * - More accurate: ~0.38 for regular, ~0.42 for headings (bolder)
 * - Empty lines are very short
 * - List items (-) and checkmarks (✅) need special handling
 */
// Common emoji regex - catches most Unicode emojis
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]/gu;

function calculateRealHeight(text: string, screenWidth: number): number {
  const horizontalPadding = 32; // ThreadPage uses paddingHorizontal: 16 each side
  const availableWidth = screenWidth - horizontalPadding;

  // Use runtime-tunable factors
  const charWidth = MARKDOWN_FONT_SIZE * CHAR_WIDTH_FACTOR;
  const headingCharWidth = 26 * HEADING_CHAR_FACTOR;
  const charsPerLine = Math.floor(availableWidth / charWidth);
  const headingCharsPerLine = Math.floor(availableWidth / headingCharWidth);

  const lines = text.split('\n');
  let totalHeight = 0;
  let totalVisualLines = 0; // Track total visual lines for phantom calculation
  let debugInfo: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line
    if (trimmed.length === 0) {
      const h = MARKDOWN_LINE_HEIGHT * EMPTY_LINE_FACTOR;
      totalHeight += h;
      totalVisualLines += 0.5; // Empty lines add less phantom
      if (DEBUG_HEIGHTS) debugInfo.push(`L${i}: empty → ${h.toFixed(0)}px`);
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const headingText = headingMatch[2]
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(EMOJI_REGEX, 'XX'); // Emoji = 2 char width
      const wrappedLines = Math.max(1, Math.ceil(headingText.length / headingCharsPerLine));
      const h = wrappedLines * 36;
      totalHeight += h;
      totalVisualLines += wrappedLines;
      if (DEBUG_HEIGHTS) debugInfo.push(`L${i}: h${headingMatch[1].length} ${headingText.length}ch → ${wrappedLines}vl × 36 = ${h}px`);
      continue;
    }

    // Horizontal rule (---)
    if (/^[-*_]{3,}$/.test(trimmed)) {
      totalHeight += 12;
      if (DEBUG_HEIGHTS) debugInfo.push(`L${i}: hr → 12px`);
      continue;
    }

    // Regular line - calculate effective width accounting for bold
    // Bold text is wider, so we expand it to simulate extra width
    let effectiveLength = 0;

    // First, handle bold: **text** → text takes ~15% more width
    const boldRegex = /\*\*([^*]+)\*\*/g;
    let lastIndex = 0;
    let match;
    let processedLine = line;

    while ((match = boldRegex.exec(line)) !== null) {
      // Regular text before bold
      effectiveLength += match.index - lastIndex;
      // Bold text is wider
      effectiveLength += match[1].length * BOLD_WIDTH_FACTOR;
      lastIndex = match.index + match[0].length;
    }
    // Remaining text after last bold
    effectiveLength += line.length - lastIndex;

    // Now strip other markdown for cleaner calculation
    const cleanLine = processedLine
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[-*+]\s+/, '')  // List marker
      .replace(/^\d+\.\s+/, '') // Numbered list
      .replace(EMOJI_REGEX, 'XX'); // Emoji = 2 char width (they're wider)

    // Use the larger of clean length or effective length (bold-adjusted)
    const charCount = Math.max(cleanLine.length, Math.round(effectiveLength));
    const wrappedLines = Math.max(1, Math.ceil(charCount / charsPerLine));
    const h = wrappedLines * MARKDOWN_LINE_HEIGHT;
    totalHeight += h;
    totalVisualLines += wrappedLines;
    if (DEBUG_HEIGHTS) {
      const boldNote = effectiveLength > cleanLine.length ? ` (${Math.round(effectiveLength)}eff)` : '';
      debugInfo.push(`L${i}: ${cleanLine.length}ch${boldNote}/${charsPerLine}cpl → ${wrappedLines}vl × ${MARKDOWN_LINE_HEIGHT} = ${h}px`);
    }
  }

  // Add phantom space: fixed base + tiny per-line with cap
  // Cap prevents runaway on very long text (100+ lines)
  const linePhantom = Math.min(totalVisualLines * LINE_PHANTOM_PX, MAX_LINE_PHANTOM);
  const phantomSpace = Math.round(BASE_PHANTOM + linePhantom);
  const finalHeight = totalHeight + phantomSpace;

  if (DEBUG_HEIGHTS && debugInfo.length <= 10) {
    const capNote = linePhantom >= MAX_LINE_PHANTOM ? ' [CAPPED]' : '';
    log.log(`[MD] Breakdown (w=${availableWidth}, cpl=${charsPerLine}):\n  ${debugInfo.join('\n  ')}\n  TOTAL: ${totalHeight} + ${phantomSpace}px phantom (${BASE_PHANTOM}base + ${linePhantom.toFixed(1)}px line${capNote}) = ${finalHeight}px`);
  }

  return finalHeight;
}

/**
 * PURE CALCULATION - NO MEASUREMENT, NO STATE, NO ADJUSTMENT
 * 
 * Calculate height ONCE from text content and use it immediately.
 * NO onContentSizeChange (causes loops), NO useState (causes re-renders).
 * Just pure math → render → done.
 */
function MeasuredMarkdownInput({
  text,
  isDark,
  style,
}: {
  text: string;
  isDark: boolean;
  style?: TextStyle;
}) {
  const trimmedText = text.trimEnd();

  // Calculate height ONCE - pure function, no state
  const calculatedHeight = useMemo(() => {
    const screenWidth = Dimensions.get('window').width;
    const height = calculateRealHeight(trimmedText, screenWidth);

    if (DEBUG_HEIGHTS) {
      const preview = trimmedText.substring(0, 40).replace(/\n/g, '↵');
      const { lines, headings } = analyzeContent(trimmedText);
      log.log(`[MD] "${preview}..." height=${height.toFixed(0)}px (lines=${lines} h=${headings})`);
    }

    return Math.max(MARKDOWN_LINE_HEIGHT, height);
  }, [trimmedText]);

  return (
    <View
      style={{
        height: calculatedHeight,
        overflow: 'hidden',
        ...(DEBUG_HEIGHTS ? { borderWidth: 1, borderColor: 'blue' } : {}),
      }}
      pointerEvents="box-none"
    >
      <MarkdownTextInput
        value={trimmedText}
        onChangeText={() => { }}
        parser={markdownParser}
        markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
        style={[styles.base, isDark ? styles.darkText : styles.lightText, style]}
        editable={false}
        multiline
        scrollEnabled={false}
        caretHidden={true}
        showSoftInputOnFocus={false}
        selectTextOnFocus={false}
        contextMenuHidden={Platform.OS === 'android'}
        onFocus={() => Keyboard.dismiss()}
      />
    </View>
  );
}

/**
 * Render markdown - uses react-native-markdown-display for both platforms
 * On iOS: double-tap opens text selection modal
 * On Android: text is directly selectable
 * 
 * Note: MeasuredMarkdownInput (expensify library) is kept but not used by default.
 * It can be enabled for iOS if needed for specific use cases.
 */
function MarkdownWithLinkHandling({
  text,
  isDark,
  style,
  needsSpacing,
}: {
  text: string;
  isDark: boolean;
  style?: TextStyle;
  needsSpacing?: boolean;
}) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const lastTapRef = useRef<number>(0);
  const blocks = useMemo(() => splitIntoBlocks(text), [text]);
  const hasAnySeparators = blocks.some((b) => b.type === 'separator');

  // iOS: Double tap opens selection modal
  const handlePress = useCallback(() => {
    if (Platform.OS === 'ios') {
      const now = Date.now();
      const DOUBLE_TAP_DELAY = 300;
      
      if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
        // Double tap detected
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        bottomSheetRef.current?.present();
        lastTapRef.current = 0; // Reset
      } else {
        lastTapRef.current = now;
      }
    }
  }, []);

  const handleDismiss = useCallback(() => {
    // Modal dismissed
  }, []);

  const renderContent = () => {
    if (!hasAnySeparators) {
      return (
        <View style={needsSpacing ? styles.partSpacing : undefined}>
          <CrossPlatformMarkdownText text={text} isDark={isDark} style={style} />
        </View>
      );
    }

    return (
      <View style={needsSpacing ? styles.partSpacing : undefined}>
        {blocks.map((block, idx) => {
          if (!block.content.trim() && block.type !== 'separator') return null;

          if (block.type === 'separator') {
            return <Separator key={`sep-${idx}`} isDark={isDark} />;
          } else {
            return (
              <View key={`txt-${idx}`}>
                <CrossPlatformMarkdownText text={block.content} isDark={isDark} style={style} />
              </View>
            );
          }
        })}
      </View>
    );
  };

  // On iOS: wrap in TouchableOpacity for double-tap detection (no visual feedback)
  // On Android: just render content directly (text is natively selectable)
  if (Platform.OS === 'ios') {
    return (
      <>
        <TouchableOpacity 
          onPress={handlePress} 
          activeOpacity={1}
        >
          {renderContent()}
        </TouchableOpacity>
        <TextSelectionModal
          sheetRef={bottomSheetRef}
          text={text}
          isDark={isDark}
          onDismiss={handleDismiss}
        />
      </>
    );
  }

  return renderContent();
}

/**
 * SelectableMarkdownText
 *
 * Renders markdown text with live formatting and full text selection support.
 * Code blocks and tables are rendered separately, everything else uses MarkdownTextInput.
 */
export const SelectableMarkdownText: React.FC<SelectableMarkdownTextProps> = ({
  children,
  style,
  isDark: isDarkProp,
}) => {
  const { colorScheme } = useColorScheme();
  const isDark = isDarkProp ?? colorScheme === 'dark';

  // Ensure children is a string and trim trailing whitespace to prevent extra spacing on iOS
  const text = typeof children === 'string'
    ? children.trimEnd()
    : String(children || '').trimEnd();

  // Split content by code blocks and tables
  const contentParts = useMemo(() => {
    // If block splitting is disabled, render everything as plain markdown
    if (DISABLE_BLOCK_SPLITTING) {
      return [{ type: 'markdown', content: text }];
    }
    
    if (!hasMarkdownTable(text) && !hasCodeBlocks(text)) {
      return [{ type: 'markdown', content: text }];
    }

    const parts: Array<{
      type: 'markdown' | 'table' | 'code';
      content: string;
      language?: string;
    }> = [];

    // First split by code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      // Add text before code block (trim to remove leading/trailing newlines)
      if (match.index > lastIndex) {
        const beforeText = text.substring(lastIndex, match.index).trim();
        if (beforeText) {
          parts.push({ type: 'markdown', content: beforeText });
        }
      }

      // Add code block
      parts.push({
        type: 'code',
        content: match[2].trim(),
        language: match[1] || undefined,
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text (trim to remove leading/trailing newlines)
    if (lastIndex < text.length) {
      const afterText = text.substring(lastIndex).trim();
      if (afterText) {
        parts.push({ type: 'markdown', content: afterText });
      }
    }

    // If no code blocks, use original text
    if (parts.length === 0) {
      parts.push({ type: 'markdown', content: text });
    }

    // Now split markdown parts by tables
    const finalParts: Array<{
      type: 'markdown' | 'table' | 'code';
      content: string;
      language?: string;
    }> = [];

    for (const part of parts) {
      if (part.type !== 'markdown' || !hasMarkdownTable(part.content)) {
        finalParts.push(part);
        continue;
      }

      // Split by tables
      const lines = part.content.split('\n');
      let currentMarkdown: string[] = [];
      let currentTable: string[] = [];
      let inTable = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nextLine = lines[i + 1];
        const isTableStart = line.includes('|') && nextLine && /\|[\s:|-]+\|/.test(nextLine);

        if (isTableStart && !inTable) {
          if (currentMarkdown.length > 0) {
            const markdownContent = currentMarkdown.join('\n').trim();
            if (markdownContent) {
              finalParts.push({ type: 'markdown', content: markdownContent });
            }
            currentMarkdown = [];
          }
          inTable = true;
          currentTable.push(line);
        } else if (inTable && line.includes('|')) {
          currentTable.push(line);
        } else if (inTable) {
          finalParts.push({ type: 'table', content: currentTable.join('\n') });
          currentTable = [];
          inTable = false;
          currentMarkdown.push(line);
        } else {
          currentMarkdown.push(line);
        }
      }

      if (currentTable.length > 0) {
        finalParts.push({ type: 'table', content: currentTable.join('\n') });
      }
      if (currentMarkdown.length > 0) {
        const markdownContent = currentMarkdown.join('\n').trim();
        if (markdownContent) {
          finalParts.push({ type: 'markdown', content: markdownContent });
        }
      }
    }

    return finalParts;
  }, [text]);

  // Render all parts
  if (
    contentParts.length > 1 ||
    (contentParts.length === 1 && contentParts[0].type !== 'markdown')
  ) {
    return (
      <View style={styles.partsContainer}>
        {contentParts.map((part, idx) => {
          // Check if we need spacing (skip if current or previous part is just whitespace)
          const needsSpacing = idx > 0 && part.content.trim().length > 0;

          if (part.type === 'table') {
            return <SimpleTable key={idx} text={part.content} isDark={isDark} />;
          }

          if (part.type === 'code') {
            return (
              <CodeBlock
                key={idx}
                code={part.content}
                language={'language' in part ? part.language : undefined}
                isDark={isDark}
              />
            );
          }

          if (!part.content.trim()) return null;

          return (
            <MarkdownWithLinkHandling
              key={idx}
              text={part.content}
              isDark={isDark}
              style={style}
              needsSpacing={needsSpacing}
            />
          );
        })}
      </View>
    );
  }

  // Pure markdown
  return <MarkdownWithLinkHandling text={text} isDark={isDark} style={style} />;
};

const styles = StyleSheet.create({
  partsContainer: {
    // No extra spacing - handled by partSpacing on children
  },
  partSpacing: {
    marginTop: 8, // Fixed 8px spacing between all parts
  },
  base: {
    fontSize: MARKDOWN_FONT_SIZE,
    lineHeight: MARKDOWN_LINE_HEIGHT,
    fontFamily: 'Roobert-Regular',
    padding: 0,
    margin: 0,
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    marginBottom: 0,
    textAlignVertical: 'top',
  } as any, // Cast to any because getters aren't in StyleSheet types
  lightText: {
    color: '#18181b', // zinc-900
  },
  darkText: {
    color: '#fafafa', // zinc-50
  },
  table: {
    borderWidth: 1,
    borderRadius: 24,
    overflow: 'hidden',
    marginVertical: 8,
  },
  tableLight: {
    borderColor: '#e4e4e7', // zinc-200
    backgroundColor: '#ffffff',
  },
  tableDark: {
    borderColor: '#3f3f46', // zinc-700
    backgroundColor: '#27272a', // zinc-800
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tableRowLight: {
    borderBottomColor: '#e4e4e7', // zinc-200
  },
  tableRowDark: {
    borderBottomColor: '#3f3f46', // zinc-700
  },
  tableCell: {
    flex: 1,
    padding: 12,
    borderRightWidth: 1,
  },
  tableCellLight: {
    borderRightColor: '#e4e4e7', // zinc-200
  },
  tableCellDark: {
    borderRightColor: '#3f3f46', // zinc-700
  },
  tableHeaderCell: {
    paddingVertical: 10,
  },
  tableHeaderCellLight: {
    backgroundColor: '#f4f4f5', // zinc-100
  },
  tableHeaderCellDark: {
    backgroundColor: '#3f3f46', // zinc-700
  },
  tableCellText: {
    fontSize: 14,
    lineHeight: 20,
  },
  tableHeaderText: {
    fontWeight: '600',
    fontSize: 14,
  },
  codeBlock: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
    marginVertical: 8,
  },
  codeBlockLight: {
    borderColor: '#DCDDDE',
    backgroundColor: '#DCDDDE80',
  },
  codeBlockDark: {
    borderColor: '#232324',
    backgroundColor: '#232324',
  },
  codeBlockHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  codeBlockLanguage: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    opacity: 0.5,
    letterSpacing: 0.8,
  },
  copyButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  copyButtonLight: {
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  copyButtonDark: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  copyButtonText: {
    fontSize: 12,
    fontWeight: '500',
  },
  codeBlockText: {
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 20,
    padding: 16,
  },
});
