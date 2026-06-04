/**
 * iOS Native Markdown Renderer using UITextView
 * 
 * Custom markdown parser and renderer that outputs UITextView components
 * with proper styling and block-level selection support.
 * 
 * Features:
 * - Native text selection via UITextView
 * - Block-level grouping (lists, blockquotes, code blocks)
 * - Inline styling (bold, italic, links, code)
 * - Proper heading hierarchy
 * - Clickable links
 */

import React from 'react';
import { View, StyleSheet, Linking } from 'react-native';
import { UITextView } from 'react-native-uitextview';

interface MarkdownToken {
    type: 'heading' | 'paragraph' | 'list' | 'blockquote' | 'code_block' | 'hr' | 'table';
    level?: number; // For headings
    content: string;
    items?: string[]; // For lists
    ordered?: boolean; // For lists
    raw?: string;
}

interface InlineToken {
    type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'bolditalic';
    content: string;
    url?: string; // For links
}

/**
 * Parse markdown into block tokens
 */
function parseMarkdownBlocks(markdown: string): MarkdownToken[] {
    const tokens: MarkdownToken[] = [];
    const lines = markdown.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Skip empty lines
        if (!line.trim()) {
            i++;
            continue;
        }

        // Headings (# - ######)
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            tokens.push({
                type: 'heading',
                level: headingMatch[1].length,
                content: headingMatch[2],
            });
            i++;
            continue;
        }

        // Horizontal rule (---, ***, ___)
        if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            tokens.push({ type: 'hr', content: '', raw: line });
            i++;
            continue;
        }

        // Code blocks (```)
        if (line.trim().startsWith('```')) {
            const codeLines: string[] = [];
            i++; // Skip opening ```
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            i++; // Skip closing ```
            tokens.push({
                type: 'code_block',
                content: codeLines.join('\n'),
                raw: codeLines.join('\n'),
            });
            continue;
        }

        // Unordered lists (-, *, +)
        const unorderedListMatch = line.match(/^[\s]*[-*+]\s+(.+)$/);
        if (unorderedListMatch) {
            const items: string[] = [unorderedListMatch[1]];
            i++;

            // Collect all consecutive list items
            while (i < lines.length) {
                const nextLine = lines[i];
                const nextMatch = nextLine.match(/^[\s]*[-*+]\s+(.+)$/);
                if (nextMatch) {
                    items.push(nextMatch[1]);
                    i++;
                } else if (!nextLine.trim()) {
                    // Allow empty lines within list
                    i++;
                } else {
                    break;
                }
            }

            tokens.push({
                type: 'list',
                ordered: false,
                items,
                content: items.join('\n'),
            });
            continue;
        }

        // Ordered lists (1., 2., etc.)
        const orderedListMatch = line.match(/^[\s]*\d+\.\s+(.+)$/);
        if (orderedListMatch) {
            const items: string[] = [orderedListMatch[1]];
            i++;

            // Collect all consecutive list items
            while (i < lines.length) {
                const nextLine = lines[i];
                const nextMatch = nextLine.match(/^[\s]*\d+\.\s+(.+)$/);
                if (nextMatch) {
                    items.push(nextMatch[1]);
                    i++;
                } else if (!nextLine.trim()) {
                    i++;
                } else {
                    break;
                }
            }

            tokens.push({
                type: 'list',
                ordered: true,
                items,
                content: items.join('\n'),
            });
            continue;
        }

        // Blockquotes (>)
        if (line.trim().startsWith('>')) {
            const quoteLines: string[] = [line.replace(/^>\s?/, '')];
            i++;

            while (i < lines.length && lines[i].trim().startsWith('>')) {
                quoteLines.push(lines[i].replace(/^>\s?/, ''));
                i++;
            }

            tokens.push({
                type: 'blockquote',
                content: quoteLines.join('\n'),
            });
            continue;
        }

        // Tables (|)
        if (line.trim().startsWith('|')) {
            const tableLines: string[] = [line];
            i++;

            while (i < lines.length && lines[i].trim().startsWith('|')) {
                tableLines.push(lines[i]);
                i++;
            }

            tokens.push({
                type: 'table',
                content: tableLines.join('\n'),
                raw: tableLines.join('\n'),
            });
            continue;
        }

        // Paragraph (default)
        const paraLines: string[] = [line];
        i++;

        // Collect lines until empty line or special syntax
        while (i < lines.length) {
            const nextLine = lines[i];
            if (!nextLine.trim()) break;
            if (/^#{1,6}\s/.test(nextLine)) break;
            if (/^[\s]*[-*+]\s/.test(nextLine)) break;
            if (/^[\s]*\d+\.\s/.test(nextLine)) break;
            if (nextLine.trim().startsWith('>')) break;
            if (nextLine.trim().startsWith('```')) break;
            if (nextLine.trim().startsWith('|')) break;
            if (/^(\-{3,}|\*{3,}|_{3,})$/.test(nextLine.trim())) break;

            paraLines.push(nextLine);
            i++;
        }

        tokens.push({
            type: 'paragraph',
            content: paraLines.join('\n'),
        });
    }

    return tokens;
}

/**
 * Parse inline markdown (bold, italic, code, links)
 */
function parseInlineMarkdown(text: string): InlineToken[] {
    const tokens: InlineToken[] = [];
    let current = 0;

    while (current < text.length) {
        // Links: [text](url)
        const linkMatch = text.slice(current).match(/^\[([^\]]+)\]\(([^\)]+)\)/);
        if (linkMatch) {
            tokens.push({
                type: 'link',
                content: linkMatch[1],
                url: linkMatch[2],
            });
            current += linkMatch[0].length;
            continue;
        }

        // Bold + Italic: ***text*** or ___text___
        const boldItalicMatch = text.slice(current).match(/^(\*{3}|_{3})([^\*_]+)\1/);
        if (boldItalicMatch) {
            tokens.push({
                type: 'bolditalic',
                content: boldItalicMatch[2],
            });
            current += boldItalicMatch[0].length;
            continue;
        }

        // Bold: **text** or __text__
        const boldMatch = text.slice(current).match(/^(\*{2}|_{2})([^\*_]+)\1/);
        if (boldMatch) {
            tokens.push({
                type: 'bold',
                content: boldMatch[2],
            });
            current += boldMatch[0].length;
            continue;
        }

        // Italic: *text* or _text_
        const italicMatch = text.slice(current).match(/^(\*|_)([^\*_]+)\1/);
        if (italicMatch) {
            tokens.push({
                type: 'italic',
                content: italicMatch[2],
            });
            current += italicMatch[0].length;
            continue;
        }

        // Inline code: `code`
        const codeMatch = text.slice(current).match(/^`([^`]+)`/);
        if (codeMatch) {
            tokens.push({
                type: 'code',
                content: codeMatch[1],
            });
            current += codeMatch[0].length;
            continue;
        }

        // Regular text
        let textContent = '';
        while (current < text.length) {
            const char = text[current];
            const upcoming = text.slice(current);

            // Check if we're hitting a special character
            if (
                upcoming.startsWith('**') ||
                upcoming.startsWith('__') ||
                upcoming.startsWith('*') ||
                upcoming.startsWith('_') ||
                upcoming.startsWith('`') ||
                upcoming.startsWith('[')
            ) {
                break;
            }

            textContent += char;
            current++;
        }

        if (textContent) {
            tokens.push({
                type: 'text',
                content: textContent,
            });
        }
    }

    return tokens;
}

/**
 * Render inline tokens to UITextView components
 * Each styled segment must be a UITextView child for proper rendering
 */
function renderInline(tokens: InlineToken[], baseStyle: any, isDark: boolean) {
    return tokens.map((token, idx) => {
        const key = `inline-${idx}`;

        switch (token.type) {
            case 'bold':
                return (
                    <UITextView key={key} style={{ fontWeight: '700' }}>
                        {token.content}
                    </UITextView>
                );

            case 'italic':
                return (
                    <UITextView key={key} style={{ fontStyle: 'italic' }}>
                        {token.content}
                    </UITextView>
                );

            case 'bolditalic':
                return (
                    <UITextView key={key} style={{ fontWeight: '700', fontStyle: 'italic' }}>
                        {token.content}
                    </UITextView>
                );

            case 'code':
                return (
                    <UITextView
                        key={key}
                        style={{
                            fontFamily: 'Menlo',
                            fontSize: 14,
                            backgroundColor: isDark ? '#27272a' : '#f4f4f5',
                            color: isDark ? '#fca5a5' : '#ef4444',
                        }}
                    >
                        {token.content}
                    </UITextView>
                );

            case 'link':
                return (
                    <UITextView
                        key={key}
                        style={{
                            color: isDark ? '#3b82f6' : '#2563eb',
                            textDecorationLine: 'underline',
                        }}
                        onPress={() => token.url && Linking.openURL(token.url)}
                    >
                        {token.content}
                    </UITextView>
                );

            case 'text':
            default:
                return token.content;
        }
    });
}

/**
 * Main iOS Markdown Renderer Component
 */
export function IOSMarkdownRenderer({
    content,
    isDark = false
}: {
    content: string;
    isDark?: boolean;
}) {
    const blocks = parseMarkdownBlocks(content);

    return (
        <View>
            {blocks.map((block, blockIdx) => {
                const key = `block-${blockIdx}`;

                switch (block.type) {
                    case 'heading': {
                        const level = block.level || 1;
                        // Much more dramatic size differences
                        const fontSizes = [32, 28, 24, 20, 18, 16];
                        const fontSize = fontSizes[level - 1] || 16;
                        const lineHeight = fontSize * 1.4;

                        const style = {
                            fontSize,
                            fontWeight: '700' as any,
                            lineHeight,
                            marginTop: level === 1 ? 24 : level === 2 ? 20 : 16,
                            marginBottom: level <= 2 ? 12 : 8,
                            color: isDark ? '#fafafa' : '#09090b',
                        };

                        const inlineTokens = parseInlineMarkdown(block.content);

                        return (
                            <View key={key} style={{ marginBottom: style.marginBottom }}>
                                <UITextView
                                    selectable={true}
                                    uiTextView={true}
                                    style={style}
                                >
                                    {renderInline(inlineTokens, style, isDark)}
                                </UITextView>
                            </View>
                        );
                    }

                    case 'paragraph': {
                        const style = {
                            fontSize: 16,
                            lineHeight: 24,
                            color: isDark ? '#fafafa' : '#09090b',
                        };

                        const inlineTokens = parseInlineMarkdown(block.content);

                        return (
                            <View key={key} style={{ marginBottom: 12 }}>
                                <UITextView
                                    selectable={true}
                                    uiTextView={true}
                                    style={style}
                                >
                                    {renderInline(inlineTokens, style, isDark)}
                                </UITextView>
                            </View>
                        );
                    }

                    case 'list': {
                        const items = block.items || [];
                        const ordered = block.ordered || false;

                        return (
                            <View key={key} style={{ marginBottom: 12 }}>
                                {/* Render entire list as one selectable block */}
                                <UITextView
                                    selectable={true}
                                    uiTextView={true}
                                    style={{
                                        fontSize: 16,
                                        lineHeight: 24,
                                        color: isDark ? '#fafafa' : '#09090b',
                                    }}
                                >
                                    {items.map((item, itemIdx) => {
                                        const prefix = ordered ? `${itemIdx + 1}. ` : '• ';
                                        const inlineTokens = parseInlineMarkdown(item);

                                        return (
                                            <UITextView key={`item-${itemIdx}`}>
                                                <UITextView style={{ fontWeight: '700' }}>
                                                    {prefix}
                                                </UITextView>
                                                {renderInline(inlineTokens, { fontSize: 16, lineHeight: 24, color: isDark ? '#fafafa' : '#09090b' }, isDark)}
                                                {itemIdx < items.length - 1 && '\n'}
                                            </UITextView>
                                        );
                                    })}
                                </UITextView>
                            </View>
                        );
                    }

                    case 'blockquote': {
                        const style = {
                            fontSize: 16,
                            lineHeight: 24,
                            fontStyle: 'italic' as any,
                            color: isDark ? '#a1a1aa' : '#71717a',
                        };

                        const inlineTokens = parseInlineMarkdown(block.content);

                        return (
                            <View key={key} style={{ marginBottom: 12 }}>
                                <View style={{
                                    borderLeftWidth: 4,
                                    borderLeftColor: isDark ? '#52525b' : '#d4d4d8',
                                    paddingLeft: 16,
                                    paddingVertical: 8,
                                    backgroundColor: isDark ? '#18181b' : '#fafafa',
                                    borderRadius: 8,
                                }}>
                                    <UITextView
                                        selectable={true}
                                        uiTextView={true}
                                        style={style}
                                    >
                                        {renderInline(inlineTokens, style, isDark)}
                                    </UITextView>
                                </View>
                            </View>
                        );
                    }

                    case 'code_block': {
                        const style = {
                            fontSize: 14,
                            lineHeight: 20,
                            fontFamily: 'Menlo',
                            color: isDark ? '#fafafa' : '#09090b',
                        };

                        return (
                            <View key={key} style={{ marginBottom: 12 }}>
                                <View style={{
                                    backgroundColor: isDark ? '#09090b' : '#fafafa',
                                    borderRadius: 8,
                                    padding: 16,
                                    borderWidth: 1,
                                    borderColor: isDark ? '#27272a' : '#e4e4e7',
                                }}>
                                    <UITextView
                                        selectable={true}
                                        uiTextView={true}
                                        style={style}
                                    >
                                        {block.content}
                                    </UITextView>
                                </View>
                            </View>
                        );
                    }

                    case 'hr': {
                        return (
                            <View
                                key={key}
                                style={{
                                    height: 1,
                                    backgroundColor: isDark ? '#3f3f46' : '#e4e4e7',
                                    marginVertical: 20,
                                }}
                            />
                        );
                    }

                    case 'table': {
                        // Simple table rendering - treat as code block for now
                        const style = {
                            fontSize: 14,
                            lineHeight: 20,
                            fontFamily: 'Menlo',
                            color: isDark ? '#fafafa' : '#09090b',
                        };

                        return (
                            <View key={key} style={{ marginBottom: 12 }}>
                                <View style={{
                                    backgroundColor: isDark ? '#09090b' : '#fafafa',
                                    borderRadius: 8,
                                    padding: 16,
                                    borderWidth: 1,
                                    borderColor: isDark ? '#27272a' : '#e4e4e7',
                                }}>
                                    <UITextView
                                        selectable={true}
                                        uiTextView={true}
                                        style={style}
                                    >
                                        {block.raw || block.content}
                                    </UITextView>
                                </View>
                            </View>
                        );
                    }

                    default:
                        return null;
                }
            })}
        </View>
    );
}
