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
 * Figma specs: 16px font, 24px line-height for paragraphs
 */
const MARKDOWN_LINE_HEIGHT = 24; // Matches Figma: line-height 24px
const MARKDOWN_FONT_SIZE = 16; // Matches Figma: 16px

/**
 * HEIGHT BUFFER ADJUSTMENT
 * Controls how much extra space to add when calculating maxHeight for clipping
 * Lower values = more aggressive clipping of bottom space
 * Adjust with: global.setMarkdownHeightBuffer(n)
 */
let HEIGHT_BUFFER = Platform.select({
  ios: 8,      // iOS - enough to not clip text but still reduce phantom space
  android: 24,  // Android needs more buffer to prevent top clipping
  default: 8,
});

export function setMarkdownHeightBuffer(buffer: number) {
  HEIGHT_BUFFER = buffer;
  console.log(
    `[SelectableMarkdown] Height buffer set to ${buffer}px. ` +
    `Press 'r' in Metro to reload and see changes.`
  );
}

/**
 * Convert markdown list markers (- or *) to actual bullet characters
 * This preprocesses the text before rendering to show proper bullets
 */
function convertListMarkersToBullets(text: string): string {
  // Match lines starting with - or * followed by space (unordered list items)
  // Handles indentation for nested lists
  return text.replace(/^(\s*)([-*])\s+/gm, '$1•  ');
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
 * 32px gap above, 24px below to compensate for heading line-height
 */
function Separator({ isDark }: { isDark: boolean }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: isDark ? 'rgba(250, 250, 250, 0.15)' : 'rgba(18, 18, 21, 0.1)', // subtle divider
        marginTop: 32,    // 32px above
        marginBottom: 24, // 24px below
      }}
    />
  );
}

/**
 * Calculate approximate height for text content to clip extra spacing
 * Uses HEIGHT_BUFFER which can be adjusted at runtime
 */
function calculateTextHeight(text: string): number {
  // Count actual newlines
  const lines = text.split('\n');
  const lineCount = lines.length;

  // Calculate height: lineCount * lineHeight + configurable buffer
  // Lower buffer = more aggressive clipping of phantom bottom space
  const estimatedHeight = lineCount * MARKDOWN_LINE_HEIGHT + HEIGHT_BUFFER;

  return estimatedHeight;
}

/**
 * Render markdown - simplified approach without splitting by links
 * Uses MarkdownTextInput for selectable text, handles links with onLinkPress
 */
function MarkdownWithLinkHandling({
  text,
  isDark,
  style,
}: {
  text: string;
  isDark: boolean;
  style?: TextStyle;
}) {
  const blocks = useMemo(() => splitIntoBlocks(text), [text]);

  // If no separators, just render as single MarkdownTextInput
  const hasAnySeparators = blocks.some((b) => b.type === 'separator');

  if (!hasAnySeparators) {
    const maxHeight = calculateTextHeight(text);

    return (
      <View style={styles.textWrapper} pointerEvents="box-none">
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
    <View>
      {blocks.map((block, idx) => {
        if (!block.content.trim() && block.type !== 'separator') return null;

        if (block.type === 'separator') {
          return <Separator key={`sep-${idx}`} isDark={isDark} />;
        } else {
          const maxHeight = calculateTextHeight(block.content);

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

  // Ensure children is a string, trim trailing whitespace, and convert list markers to bullets
  const rawText = typeof children === 'string'
    ? children.trimEnd()
    : String(children || '').trimEnd();
  const text = convertListMarkersToBullets(rawText);

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
      <View style={{ gap: 16 }}>
        {contentParts.map((part, idx) => {
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
    color: '#121215', // kortix-black per Figma
  },
  darkText: {
    color: '#fafafa', // white for dark mode
  },
  table: {
    borderWidth: 1.5,
    borderRadius: 24, // rounded-3xl per Figma
    overflow: 'hidden',
  },
  tableLight: {
    borderColor: '#e5e5e5', // #e5e5e5 per Figma
    backgroundColor: '#ffffff',
  },
  tableDark: {
    borderColor: '#404040',
    backgroundColor: '#1a1a1a',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1.5,
  },
  tableRowLight: {
    borderBottomColor: '#e5e5e5',
  },
  tableRowDark: {
    borderBottomColor: '#404040',
  },
  tableCell: {
    flex: 1,
    padding: 12,
    borderRightWidth: 1.5,
  },
  tableCellLight: {
    borderRightColor: '#e5e5e5',
  },
  tableCellDark: {
    borderRightColor: '#404040',
  },
  tableHeaderCell: {
    paddingVertical: 8,
    height: 40,
  },
  tableHeaderCellLight: {
    backgroundColor: '#f5f5f5', // per Figma
  },
  tableHeaderCellDark: {
    backgroundColor: '#2a2a2a',
  },
  tableCellText: {
    fontSize: 15, // 15px per Figma
    lineHeight: 24,
    fontFamily: 'Roobert-Regular',
  },
  tableHeaderText: {
    fontWeight: '500', // Medium
    fontSize: 15, // 15px per Figma
    fontFamily: 'Roobert-Medium',
  },
  codeBlock: {
    borderRadius: 12, // rounded-lg
    borderWidth: 1,
    overflow: 'hidden',
  },
  codeBlockLight: {
    borderColor: '#e5e5e5', // neutral-200
    backgroundColor: '#f5f5f5', // neutral-100
  },
  codeBlockDark: {
    borderColor: '#404040', // neutral-700
    backgroundColor: '#262626', // neutral-800
  },
  codeBlockHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5', // neutral-200 default, overridden per theme
  },
  codeBlockLanguage: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    color: '#737373', // neutral-500
    letterSpacing: 0.8,
  },
  copyButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  copyButtonLight: {
    backgroundColor: '#e5e5e5', // neutral-200
  },
  copyButtonDark: {
    backgroundColor: '#404040', // neutral-700
  },
  copyButtonText: {
    fontSize: 12,
    fontWeight: '500',
  },
  codeBlockText: {
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 24, // leading-relaxed
    padding: 16,
  },
});
