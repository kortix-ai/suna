/**
 * SelectableMarkdownText Component
 *
 * A wrapper around MarkdownTextInput that provides selectable markdown text
 * with proper styling. This replaces the old hybrid approach with a clean,
 * native solution using @expensify/react-native-live-markdown.
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
  StyleSheet,
  TextStyle,
  ViewStyle,
  View,
  Text as RNText,
  Pressable,
  Linking,
  Alert,
  LogBox,
  Keyboard,
} from 'react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import Markdown from 'react-native-markdown-display';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { useColorScheme } from 'nativewind';
import * as Clipboard from 'expo-clipboard';

// Suppress known warning from react-native-markdown-display library
LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);

export interface SelectableMarkdownTextProps {
  /** The markdown text content to render */
  children: string;
  /** Additional style for the text input */
  style?: TextStyle | ViewStyle;
  /** Whether to use dark mode (if not provided, will use color scheme hook) */
  isDark?: boolean;
}

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
 * Handle link press by opening in browser
 */
async function handleLinkPress(url: string) {
  console.log('[Link] Opening URL:', url);
  try {
    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const canOpen = await Linking.canOpenURL(cleanUrl);
    if (canOpen) {
      await Linking.openURL(cleanUrl);
    } else {
      Alert.alert('Error', `Cannot open: ${cleanUrl}`);
    }
  } catch (error) {
    console.error('[Link] Error:', error);
    Alert.alert('Error', 'Failed to open link');
  }
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
      console.error('Failed to copy code:', err);
    }
  };

  return (
    <View style={[styles.codeBlock, isDark ? styles.codeBlockDark : styles.codeBlockLight]}>
      <View style={styles.codeBlockHeader}>
        {language && (
          <RNText style={[styles.codeBlockLanguage, isDark ? styles.darkText : styles.lightText]}>
            {language}
          </RNText>
        )}
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
 * Check if a line contains a markdown link
 */
function lineHasLink(line: string): boolean {
  return /\[([^\]]+)\]\(([^\)]+)\)/.test(line);
}

/**
 * Check if a line is a separator
 */
function isSeparatorLine(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

/**
 * Split text into blocks - separators, lines with links, lines without
 * This minimizes the amount rendered with non-selectable markdown
 */
function splitIntoBlocks(
  text: string
): Array<{ type: 'separator' | 'links' | 'text'; content: string }> {
  const lines = text.split('\n');
  const blocks: Array<{ type: 'separator' | 'links' | 'text'; content: string }> = [];

  let currentBlock: string[] = [];
  let currentHasLinks = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a separator line
    if (isSeparatorLine(line)) {
      // Flush current block
      if (currentBlock.length > 0) {
        blocks.push({
          type: currentHasLinks ? 'links' : 'text',
          content: currentBlock.join('\n'),
        });
        currentBlock = [];
      }
      // Add separator as its own block
      blocks.push({
        type: 'separator',
        content: line,
      });
      continue;
    }

    const thisLineHasLink = lineHasLink(line);

    if (currentBlock.length === 0) {
      currentBlock.push(line);
      currentHasLinks = thisLineHasLink;
    } else if (thisLineHasLink === currentHasLinks) {
      currentBlock.push(line);
    } else {
      blocks.push({
        type: currentHasLinks ? 'links' : 'text',
        content: currentBlock.join('\n'),
      });
      currentBlock = [line];
      currentHasLinks = thisLineHasLink;
    }
  }

  if (currentBlock.length > 0) {
    blocks.push({
      type: currentHasLinks ? 'links' : 'text',
      content: currentBlock.join('\n'),
    });
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
        marginVertical: 16,
      }}
    />
  );
}

/**
 * Markdown styles for react-native-markdown-display
 */
const getMarkdownDisplayStyles = (isDark: boolean) => ({
  body: {
    color: isDark ? '#fafafa' : '#18181b',
    fontSize: 16,
    lineHeight: 24,
  },
  link: {
    color: isDark ? '#60a5fa' : '#2563eb',
    textDecorationLine: 'underline' as const,
  },
  heading1: { fontSize: 28, fontWeight: '700' as const, color: isDark ? '#fafafa' : '#18181b' },
  heading2: { fontSize: 24, fontWeight: '700' as const, color: isDark ? '#fafafa' : '#18181b' },
  heading3: { fontSize: 20, fontWeight: '700' as const, color: isDark ? '#fafafa' : '#18181b' },
  heading4: { fontSize: 18, fontWeight: '600' as const, color: isDark ? '#fafafa' : '#18181b' },
  strong: { fontWeight: '700' as const },
  em: { fontStyle: 'italic' as const },
  code_inline: {
    fontFamily: 'monospace',
    backgroundColor: isDark ? '#374151' : '#e5e7eb',
    color: isDark ? '#fafafa' : '#18181b',
  },
  bullet_list: { marginVertical: 0 },
  ordered_list: { marginVertical: 0 },
  list_item: { marginVertical: 0 },
  paragraph: { marginVertical: 0 },
});

/**
 * Hybrid approach:
 * - Lines WITHOUT links → MarkdownTextInput (selectable)
 * - Lines WITH links → react-native-markdown-display (clickable)
 */
function MarkdownWithLinkHandling({
  text,
  isDark,
  style,
  needsSpacing,
}: {
  text: string;
  isDark: boolean;
  style?: TextStyle | ViewStyle;
  needsSpacing?: boolean;
}) {
  const blocks = useMemo(() => splitIntoBlocks(text), [text]);
  const markdownStyles = useMemo(() => getMarkdownDisplayStyles(isDark), [isDark]);

  // If no blocks have links or separators, just use selectable MarkdownTextInput
  const hasAnyLinks = blocks.some((b) => b.type === 'links');
  const hasAnySeparators = blocks.some((b) => b.type === 'separator');

  if (!hasAnyLinks && !hasAnySeparators) {
    return (
      <View style={needsSpacing && styles.partSpacing} pointerEvents="box-none">
        <MarkdownTextInput
          value={text}
          onChangeText={() => {}}
          parser={markdownParser}
          markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
          style={[styles.base, isDark ? styles.darkText : styles.lightText, style]}
          editable={false}
          multiline
          scrollEnabled={false}
          caretHidden={true}
          showSoftInputOnFocus={false}
          selectTextOnFocus={false}
          onFocus={() => Keyboard.dismiss()}
        />
      </View>
    );
  }

  // Hybrid: each block uses appropriate component
  return (
    <View style={needsSpacing && styles.partSpacing}>
      {blocks.map((block, idx) => {
        if (!block.content.trim() && block.type !== 'separator') return null;

        if (block.type === 'separator') {
          // Separator → custom component
          return <Separator key={`sep-${idx}`} isDark={isDark} />;
        } else if (block.type === 'links') {
          // Lines with links → react-native-markdown-display (clickable)
          return (
            <View key={`md-${idx}`} style={{ marginVertical: 0 }}>
              <Markdown
                style={markdownStyles}
                onLinkPress={(url) => {
                  console.log('[Link] Clicked:', url);
                  handleLinkPress(url);
                  return false;
                }}>
                {block.content}
              </Markdown>
            </View>
          );
        } else {
          // Lines without links → MarkdownTextInput (selectable)
          return (
            <View key={`txt-${idx}`} pointerEvents="box-none">
              <MarkdownTextInput
                value={block.content}
                onChangeText={() => {}}
                parser={markdownParser}
                markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
                style={[styles.base, isDark ? styles.darkText : styles.lightText, style]}
                editable={false}
                multiline
                scrollEnabled={false}
                caretHidden={true}
                showSoftInputOnFocus={false}
                selectTextOnFocus={false}
                onFocus={() => Keyboard.dismiss()}
              />
            </View>
          );
        }
      })}
    </View>
  );
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

  // Ensure children is a string
  const text = typeof children === 'string' ? children : String(children || '');

  // Split content by code blocks and tables
  const contentParts = useMemo(() => {
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
      // Add text before code block
      if (match.index > lastIndex) {
        const beforeText = text.substring(lastIndex, match.index);
        if (beforeText.trim()) {
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

    // Add remaining text
    if (lastIndex < text.length) {
      const afterText = text.substring(lastIndex);
      if (afterText.trim()) {
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
            finalParts.push({ type: 'markdown', content: currentMarkdown.join('\n') });
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
        finalParts.push({ type: 'markdown', content: currentMarkdown.join('\n') });
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
            return (
              <View key={idx} style={needsSpacing && styles.partSpacing}>
                <SimpleTable text={part.content} isDark={isDark} />
              </View>
            );
          }

          if (part.type === 'code') {
            return (
              <View key={idx} style={needsSpacing && styles.partSpacing}>
                <CodeBlock
                  code={part.content}
                  language={'language' in part ? part.language : undefined}
                  isDark={isDark}
                />
              </View>
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
    fontSize: 16,
    lineHeight: 24,
    fontFamily: 'System',
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
  },
  lightText: {
    color: '#18181b', // zinc-900
  },
  darkText: {
    color: '#fafafa', // zinc-50
  },
  table: {
    borderWidth: 1,
    borderRadius: 24, // 2xl
    overflow: 'hidden',
    // No marginBottom - spacing handled by partSpacing
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
    borderRadius: 24, // 2xl
    borderWidth: 1,
    overflow: 'hidden',
    // No marginBottom - spacing handled by partSpacing
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
    borderBottomColor: '#DCDDDE',
  },
  codeBlockLanguage: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    opacity: 0.6,
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
