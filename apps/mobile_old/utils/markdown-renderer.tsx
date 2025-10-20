import { useTheme } from '@/hooks/useThemeColor';
import React from 'react';
import { StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';

interface MarkdownProps {
    children: string;
    style?: any;
}

export const MarkdownComponent: React.FC<MarkdownProps> = ({ children, style }) => {
    const theme = useTheme();
    const processedContent = processUnicodeContent(children);

    const markdownStyles = StyleSheet.create({
        body: {
            color: theme.foreground,
            fontSize: 16,
            lineHeight: 24,
        },
        heading1: {
            color: theme.foreground,
            fontSize: 24,
            fontWeight: 'bold',
            marginVertical: 8,
        },
        heading2: {
            color: theme.foreground,
            fontSize: 20,
            fontWeight: 'bold',
            marginVertical: 8,
        },
        heading3: {
            color: theme.foreground,
            fontSize: 18,
            fontWeight: 'bold',
            marginVertical: 6,
        },
        heading4: {
            color: theme.foreground,
            fontSize: 16,
            fontWeight: 'bold',
            marginVertical: 6,
        },
        heading5: {
            color: theme.foreground,
            fontSize: 14,
            fontWeight: 'bold',
            marginVertical: 4,
        },
        heading6: {
            color: theme.foreground,
            fontSize: 12,
            fontWeight: 'bold',
            marginVertical: 4,
        },
        paragraph: {
            color: theme.foreground,
            fontSize: 16,
            lineHeight: 24,
            marginVertical: 4,
        },
        code_inline: {
            backgroundColor: theme.muted,
            color: theme.mutedForeground,
            paddingHorizontal: 4,
            paddingVertical: 2,
            borderRadius: 4,
            fontSize: 14,
            fontFamily: 'monospace',
        },
        code_block: {
            backgroundColor: theme.muted,
            color: theme.mutedForeground,
            padding: 12,
            borderRadius: 8,
            marginVertical: 8,
            fontSize: 14,
            fontFamily: 'monospace',
        },
        fence: {
            backgroundColor: theme.muted,
            color: theme.mutedForeground,
            padding: 12,
            borderRadius: 8,
            marginVertical: 8,
            fontSize: 14,
            fontFamily: 'monospace',
        },
        bullet_list: {
            marginVertical: 4,
        },
        ordered_list: {
            marginVertical: 4,
        },
        list_item: {
            color: theme.foreground,
            fontSize: 16,
            lineHeight: 24,
            marginVertical: 2,
        },
        blockquote: {
            backgroundColor: theme.muted + '40',
            borderLeftWidth: 3,
            borderLeftColor: theme.border,
            paddingLeft: 12,
            paddingVertical: 8,
            marginVertical: 8,
        },
        strong: {
            fontWeight: 'bold',
            color: theme.foreground,
        },
        em: {
            fontStyle: 'italic',
            color: theme.foreground,
        },
        table: {
            borderWidth: 1,
            borderColor: theme.border,
            marginVertical: 8,
        },
        thead: {
            backgroundColor: theme.muted,
        },
        tbody: {
            backgroundColor: 'transparent',
        },
        th: {
            color: theme.foreground,
            fontWeight: 'bold',
            padding: 8,
            borderRightWidth: 1,
            borderRightColor: theme.border,
        },
        td: {
            color: theme.foreground,
            padding: 8,
            borderRightWidth: 1,
            borderRightColor: theme.border,
        },
        tr: {
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
    });

    return (
        <Markdown style={markdownStyles}>
            {processedContent}
        </Markdown>
    );
};

export function processUnicodeContent(content: string): string {
    if (!content) return '';

    // Process \uXXXX Unicode escape sequences (BMP characters)
    const bmpProcessed = content.replace(
        /\\u([0-9a-fA-F]{4})/g,
        (_, codePoint) => String.fromCharCode(parseInt(codePoint, 16))
    );

    // Process \uXXXXXXXX Unicode escape sequences (supplementary plane characters)
    return bmpProcessed.replace(/\\u([0-9a-fA-F]{8})/g, (_, codePoint) => {
        const highSurrogate = parseInt(codePoint.substring(0, 4), 16);
        const lowSurrogate = parseInt(codePoint.substring(4, 8), 16);
        return String.fromCharCode(highSurrogate, lowSurrogate);
    });
}

// Export as Markdown for backward compatibility
export { MarkdownComponent as Markdown };
