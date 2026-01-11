/**
 * Live Markdown Configuration
 * 
 * Configuration for @expensify/react-native-live-markdown
 * Provides parser worklet and styles for markdown rendering with text selection support
 */

import { Platform } from 'react-native';
import type { MarkdownStyle } from '@expensify/react-native-live-markdown';
import { log } from '@/lib/logger';

/**
 * Custom markdown parser worklet
 * 
 * Parses markdown syntax and returns ranges for styling.
 * Must be marked as 'worklet' to run on UI thread.
 */
export function markdownParser(input: string) {
  'worklet';
  
  const ranges: Array<{
    type: 'bold' | 'italic' | 'strikethrough' | 'emoji' | 'mention-here' | 'mention-user' | 'mention-report' | 'link' | 'code' | 'pre' | 'blockquote' | 'h1' | 'syntax';
    start: number;
    length: number;
    depth?: number;
    url?: string;
  }> = [];

  // Code blocks: ```...``` - style the entire block
  const codeBlockRegex = /```[\w]*\n[\s\S]*?```/g;
  let match;
  while ((match = codeBlockRegex.exec(input)) !== null) {
    // Mark entire code block with 'pre' style
    ranges.push({ start: match.index, length: match[0].length, type: 'pre' });
  }

  // Horizontal separators: ---, ***, ___
  const separatorRegex = /^(-{3,}|\*{3,}|_{3,})$/gm;
  while ((match = separatorRegex.exec(input)) !== null) {
    // Style separator lines
    ranges.push({ start: match.index, length: match[1].length, type: 'syntax' });
  }

  // Table detection: lines with | ... |
  const tableRegex = /^\|.*\|$/gm;
  while ((match = tableRegex.exec(input)) !== null) {
    // Dim table markup slightly
    ranges.push({ start: match.index, length: match[0].length, type: 'code' });
  }

  // Bold: **text** or __text__
  const boldRegex = /(\*\*|__)(.*?)\1/g;
  while ((match = boldRegex.exec(input)) !== null) {
    ranges.push({ start: match.index, length: match[1].length, type: 'syntax' });
    ranges.push({ start: match.index + match[1].length, length: match[2].length, type: 'bold' });
    ranges.push({ start: match.index + match[1].length + match[2].length, length: match[1].length, type: 'syntax' });
  }

  // Italic: *text* or _text_ (but not part of bold)
  const italicRegex = /(?<!\*)\*(?!\*)([^*]+)\*(?!\*)|(?<!_)_(?!_)([^_]+)_(?!_)/g;
  while ((match = italicRegex.exec(input)) !== null) {
    const content = match[1] || match[2];
    ranges.push({ start: match.index, length: 1, type: 'syntax' });
    ranges.push({ start: match.index + 1, length: content.length, type: 'italic' });
    ranges.push({ start: match.index + 1 + content.length, length: 1, type: 'syntax' });
  }

  // Strikethrough: ~~text~~
  const strikeRegex = /~~(.*?)~~/g;
  while ((match = strikeRegex.exec(input)) !== null) {
    ranges.push({ start: match.index, length: 2, type: 'syntax' });
    ranges.push({ start: match.index + 2, length: match[1].length, type: 'strikethrough' });
    ranges.push({ start: match.index + 2 + match[1].length, length: 2, type: 'syntax' });
  }

  // Inline code: `code`
  const codeRegex = /`([^`]+)`/g;
  while ((match = codeRegex.exec(input)) !== null) {
    ranges.push({ start: match.index, length: 1, type: 'syntax' });
    ranges.push({ start: match.index + 1, length: match[1].length, type: 'code' });
    ranges.push({ start: match.index + 1 + match[1].length, length: 1, type: 'syntax' });
  }

  // Links: [text](url) - improved to handle parentheses in URLs
  const linkRegex = /\[([^\]]+)\]\(((?:[^()]|\([^)]*\))*)\)/g;
  while ((match = linkRegex.exec(input)) !== null) {
    const linkText = match[1];
    const url = match[2];
    ranges.push({ start: match.index, length: 1, type: 'syntax' }); // [
    ranges.push({ start: match.index + 1, length: linkText.length, type: 'link', url: url }); // text
    ranges.push({ start: match.index + 1 + linkText.length, length: 2, type: 'syntax' }); // ](
    ranges.push({ start: match.index + 1 + linkText.length + 2, length: url.length, type: 'syntax' }); // url
    ranges.push({ start: match.index + 1 + linkText.length + 2 + url.length, length: 1, type: 'syntax' }); // )
  }

  // Headings: # Heading (all levels h1-h6 use h1 style)
  // Parse AFTER bold/italic/etc so we don't override their syntax markers
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  while ((match = headingRegex.exec(input)) !== null) {
    const headingStart = match.index;
    const syntaxEnd = headingStart + match[1].length + 1;
    const contentStart = syntaxEnd;
    const contentEnd = headingStart + match[0].length;
    
    // Mark "# " as syntax (will be made invisible in config)
    ranges.push({ start: headingStart, length: match[1].length + 1, type: 'syntax' });
    
    // For heading content, only mark positions that are NOT already marked as syntax
    // This prevents overriding bold/italic syntax markers
    const existingSyntaxRanges = ranges.filter(r => 
      r.type === 'syntax' && 
      r.start >= contentStart && 
      r.start < contentEnd
    );
    
    // Create h1 ranges only for gaps between syntax markers
    let lastEnd = contentStart;
    for (const syntaxRange of existingSyntaxRanges.sort((a, b) => a.start - b.start)) {
      if (syntaxRange.start > lastEnd) {
        // There's a gap - mark it as h1
        ranges.push({ start: lastEnd, length: syntaxRange.start - lastEnd, type: 'h1' });
      }
      lastEnd = syntaxRange.start + syntaxRange.length;
    }
    // Mark remaining content after last syntax marker
    if (lastEnd < contentEnd) {
      ranges.push({ start: lastEnd, length: contentEnd - lastEnd, type: 'h1' });
    }
  }

  // Blockquotes: > text
  const blockquoteRegex = /^>\s+(.+)$/gm;
  while ((match = blockquoteRegex.exec(input)) !== null) {
    ranges.push({ start: match.index, length: 2, type: 'syntax' });
    ranges.push({ start: match.index + 2, length: match[1].length, type: 'blockquote' });
  }

  return ranges;
}

/**
 * Font family configuration
 */
const FONT_FAMILY_BASE = 'Roobert-Regular';
const FONT_FAMILY_BOLD = 'Roobert-SemiBold';
const FONT_FAMILY_HEADING = 'Roobert-Bold';

const FONT_FAMILY_MONOSPACE = Platform.select({
  ios: 'Courier',
  default: 'monospace',
});

const FONT_FAMILY_EMOJI = Platform.select({
  ios: 'System',
  android: 'Noto Color Emoji',
  default: 'System, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji',
});

/**
 * HEADING INDENT CONTROL - Adjust this to fix heading alignment without rebuilding!
 * Negative values pull headings LEFT to eliminate the indent.
 * Super aggressive default to fight React Native's default text indentation.
 * Adjust with: global.setHeadingMargin(VALUE) and hot reload (press 'r')
 * Try: 0 (default), -50, -100, -500, -1000, -2000 until perfect
 */
let HEADING_MARGIN_LEFT = 0;

/**
 * LINK UNDERLINE CONTROL - Toggle underlines for markdown links
 * Set to false to remove underlines (default), true to show them
 * Adjust with: global.setLinkUnderline(true/false) and hot reload (press 'r')
 */
let LINK_UNDERLINE_ENABLED = false;

/**
 * Helper to update heading margin at runtime (no rebuild needed!)
 * 
 * Usage in Metro console or React Native Debugger:
 * ```javascript
 * global.setHeadingMargin(-150); // Try different values: -50, -80, -100, -150, -200
 * global.getHeadingMargin(); // Check current value
 * ```
 * Then press 'r' in Metro to hot reload and see changes.
 */
export function setHeadingMarginLeft(value: number) {
  HEADING_MARGIN_LEFT = value;
  log.log(`[MarkdownConfig] Heading margin set to ${value}. Press 'r' in Metro to reload.`);
}

export function getHeadingMarginLeft() {
  return HEADING_MARGIN_LEFT;
}

/**
 * Helper to toggle link underlines at runtime (no rebuild needed!)
 * 
 * Usage in Metro console or React Native Debugger:
 * ```javascript
 * global.setLinkUnderline(false); // Remove underlines (default)
 * global.setLinkUnderline(true);  // Show underlines
 * global.getLinkUnderline(); // Check current value
 * ```
 * Then press 'r' in Metro to hot reload and see changes.
 */
export function setLinkUnderline(enabled: boolean) {
  LINK_UNDERLINE_ENABLED = enabled;
  log.log(`[MarkdownConfig] Link underline ${enabled ? 'enabled' : 'disabled'}. Press 'r' in Metro to reload.`);
}

export function getLinkUnderline() {
  return LINK_UNDERLINE_ENABLED;
}

// Expose to global for easy console access in dev mode
if (__DEV__) {
  (global as any).setHeadingMargin = setHeadingMarginLeft;
  (global as any).getHeadingMargin = getHeadingMarginLeft;
  (global as any).setLinkUnderline = setLinkUnderline;
  (global as any).getLinkUnderline = getLinkUnderline;
}

/**
 * Light mode markdown styles
 */
export const lightMarkdownStyle: MarkdownStyle = {
  syntax: {
    color: 'transparent',
    fontSize: 0.01, // 0.01px on Android (int cast), iOS handles float fine
  } as any,
  link: {
    color: '#2563eb', // blue-600
    fontFamily: FONT_FAMILY_BASE,
    get textDecorationLine() { return LINK_UNDERLINE_ENABLED ? 'underline' : 'none'; }, // Dynamic value
  } as any,
  h1: {
    fontSize: 26,
    lineHeight: 36, // Increased for better readability
    fontFamily: FONT_FAMILY_HEADING,
    get marginLeft() { return HEADING_MARGIN_LEFT; }, // Dynamic value
    paddingLeft: 0,
    paddingTop: 4, // Small top padding for visual separation
    paddingBottom: 2,
    marginTop: 0,
    marginBottom: 0,
  } as any, // Cast to any because we patched the library to add these fields
  emoji: {
    fontSize: 20,
    fontFamily: FONT_FAMILY_EMOJI,
  },
  blockquote: {
    borderColor: '#71717a', // zinc-500
    borderWidth: 4,
    marginLeft: 6,
    paddingLeft: 6,
    fontFamily: FONT_FAMILY_BASE,
  } as any,
  code: {
    fontFamily: FONT_FAMILY_MONOSPACE,
    fontSize: 14,
    color: '#dc2626', // red-600
    backgroundColor: '#f4f4f5', // zinc-100
  },
  pre: {
    fontFamily: FONT_FAMILY_MONOSPACE,
    fontSize: 14,
    color: '#18181b', // zinc-900
    backgroundColor: '#f4f4f5', // zinc-100
  },
};

/**
 * Dark mode markdown styles
 */
export const darkMarkdownStyle: MarkdownStyle = {
  syntax: {
    color: 'transparent',
    fontSize: 0.01, // 0.01px on Android (int cast), iOS handles float fine
  } as any,
  link: {
    color: '#3b82f6', // blue-500
    fontFamily: FONT_FAMILY_BASE,
    get textDecorationLine() { return LINK_UNDERLINE_ENABLED ? 'underline' : 'none'; }, // Dynamic value
  } as any,
  h1: {
    fontSize: 26,
    lineHeight: 36, // Increased for better readability
    fontFamily: FONT_FAMILY_HEADING,
    get marginLeft() { return HEADING_MARGIN_LEFT; }, // Dynamic value
    paddingLeft: 0,
    paddingTop: 4, // Small top padding for visual separation
    paddingBottom: 2,
    marginTop: 0,
    marginBottom: 0,
  } as any, // Cast to any because we patched the library to add these fields
  emoji: {
    fontSize: 20,
    fontFamily: FONT_FAMILY_EMOJI,
  },
  blockquote: {
    borderColor: '#a1a1aa', // zinc-400
    borderWidth: 4,
    marginLeft: 6,
    paddingLeft: 6,
    fontFamily: FONT_FAMILY_BASE,
  } as any,
  code: {
    fontFamily: FONT_FAMILY_MONOSPACE,
    fontSize: 14,
    color: '#fca5a5', // red-300
    backgroundColor: '#27272a', // zinc-800
  },
  pre: {
    fontFamily: FONT_FAMILY_MONOSPACE,
    fontSize: 14,
    color: '#fafafa', // zinc-50
    backgroundColor: '#27272a', // zinc-800
  },
};


