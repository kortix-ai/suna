/**
 * SelectableMarkdownText Component
 *
 * A wrapper around MarkdownTextInput that provides selectable markdown text
 * with proper styling. This replaces the old hybrid approach with a clean,
 * native solution using @expensify/react-native-live-markdown.
 */

import React, { useMemo, useState } from 'react';
import {
  StyleSheet,
  TextStyle,
  View,
  Text as RNText,
  Pressable,
  Linking,
  Alert,
  LogBox,
  Keyboard,
  Platform,
  Dimensions,
} from 'react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { useColorScheme } from 'nativewind';
import * as Clipboard from 'expo-clipboard';

// Suppress known warning from react-native-markdown-display library
LogBox.ignoreLogs(['A props object containing a "key" prop is being spread into JSX']);

/**
 * LINE HEIGHT CONFIGURATION
 * Adjust these values to tune text spacing and eliminate extra bottom space
 */
const MARKDOWN_LINE_HEIGHT = 26; // Main line height for readability (increased from 20)
const MARKDOWN_FONT_SIZE = 16;

/**
 * HEIGHT BUFFER ADJUSTMENT
 * Controls how much extra space to add when calculating maxHeight for clipping
 * Lower values = more aggressive clipping of bottom space
 * Adjust with: global.setMarkdownHeightBuffer(n)
 */
let HEIGHT_BUFFER = Platform.select({
  ios: 4,
  android: 12,
  default: 4,
});

export function setMarkdownHeightBuffer(buffer: number) {
  HEIGHT_BUFFER = buffer;
  console.log(
    `[SelectableMarkdown] Height buffer set to ${buffer}px. ` +
    `Press 'r' in Metro to reload and see changes.`
  );
}

export function getMarkdownHeightBuffer() {
  return HEIGHT_BUFFER;
}

// Expose to global for easy console access
if (__DEV__) {
  (global as any).setMarkdownHeightBuffer = setMarkdownHeightBuffer;
  (global as any).getMarkdownHeightBuffer = getMarkdownHeightBuffer;
  console.log('[SelectableMarkdown] Dev helpers available:');
  console.log('  - global.setMarkdownHeightBuffer(n) // Set height buffer (try 0-10)');
  console.log('  - global.getMarkdownHeightBuffer() // Check current buffer');
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
      console.error('Failed to copy code:', err);
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
      // Flush current block
      if (currentBlock.length > 0) {
        blocks.push({
          type: 'text',
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

    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    blocks.push({
      type: 'text',
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
        marginVertical: 12, // Consistent with code blocks and tables
      }}
    />
  );
}

function calculateTextHeight(text: string): { height: number; lineCount: number; wrappedLineEstimate: number; buffer: number; charCount: number } {
  const screenWidth = Dimensions.get('window').width;
  const horizontalPadding = 32;
  const availableWidth = screenWidth - horizontalPadding;
  const avgCharWidth = MARKDOWN_FONT_SIZE * 0.47;
  const charsPerLine = Math.floor(availableWidth / avgCharWidth);
  
  const lines = text.split('\n');
  const lineCount = lines.length;
  let wrappedLineEstimate = 0;
  let totalChars = 0;
  
  lines.forEach(line => {
    totalChars += line.length;
    if (line.length > 0) {
      wrappedLineEstimate += Math.max(1, Math.round(line.length / charsPerLine + 0.3));
    } else {
      wrappedLineEstimate += 1;
    }
  });

  const visualLines = Math.max(lineCount, wrappedLineEstimate);
  const estimatedHeight = Math.round(visualLines * MARKDOWN_LINE_HEIGHT * 0.88);

  return { 
    height: estimatedHeight, 
    lineCount, 
    wrappedLineEstimate,
    buffer: 0,
    charCount: totalChars
  };
}

/**
 * Render markdown - simplified approach without splitting by links
 * Uses MarkdownTextInput for selectable text, handles links with onLinkPress
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
  const blocks = useMemo(() => splitIntoBlocks(text), [text]);

  // If no separators, just render as single MarkdownTextInput
  const hasAnySeparators = blocks.some((b) => b.type === 'separator');

  if (!hasAnySeparators) {
    const heightInfo = calculateTextHeight(text);
    const maxHeight = heightInfo.height;

    return (
      <View style={[needsSpacing && styles.partSpacing, styles.textWrapper]} pointerEvents="box-none">
        <View 
          style={[styles.textWrapperInner, { maxHeight }]} 
          pointerEvents={Platform.OS === 'android' ? 'none' : 'box-none'}
        >
          <MarkdownTextInput
            value={text.trimEnd()}
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
      </View>
    );
  }

  // Render blocks with separators
  return (
    <View style={needsSpacing && styles.partSpacing}>
      {blocks.map((block, idx) => {
        if (!block.content.trim() && block.type !== 'separator') return null;

        if (block.type === 'separator') {
          return <Separator key={`sep-${idx}`} isDark={isDark} />;
        } else {
          const heightInfo = calculateTextHeight(block.content);
          const maxHeight = heightInfo.height;

          return (
            <View key={`txt-${idx}`} style={styles.textWrapper} pointerEvents="box-none">
              <View 
                style={[styles.textWrapperInner, { maxHeight }]} 
                pointerEvents={Platform.OS === 'android' ? 'none' : 'box-none'}
              >
                <MarkdownTextInput
                  value={block.content.trimEnd()}
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

  // Ensure children is a string and trim trailing whitespace to prevent extra spacing on iOS
  const text = typeof children === 'string'
    ? children.trimEnd()
    : String(children || '').trimEnd();

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
  textWrapper: {
    // Wrapper to clip extra TextInput spacing
    overflow: Platform.OS === 'android' ? 'visible' : 'hidden',
  },
  textWrapperInner: {
    // Inner wrapper to clip bottom space without cutting content
    // Android: no negative margin to prevent top clipping
    marginBottom: Platform.OS === 'android' ? 0 : -4,
  },
  base: {
    fontSize: MARKDOWN_FONT_SIZE,
    lineHeight: MARKDOWN_LINE_HEIGHT,
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
  } as any, // Cast to any because getters aren't in StyleSheet types
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
    marginVertical: 12, // Consistent vertical spacing with code blocks and separators
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
    marginVertical: 12, // Consistent vertical spacing with tables and separators
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
