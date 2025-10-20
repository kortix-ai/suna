import { useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Colors } from '../../constants/Colors';
import { useColorScheme } from '../../hooks/useColorScheme';

interface CodeRendererProps {
    content: string;
    language?: string;
    showLineNumbers?: boolean;
    style?: any;
}


// Basic syntax highlighting for common languages
const highlightSyntax = (content: string, language: string, isDark: boolean) => {
    if (!content || !language) return [{ type: 'text', content }];

    const lines = content.split('\n');
    const highlightedLines = lines.map(line => {
        if (!line.trim()) return [{ type: 'text', content: line }];

        const tokens = [];
        let currentToken = '';
        let i = 0;

        while (i < line.length) {
            const char = line[i];

            // Comments
            if (char === '/' && line[i + 1] === '/') {
                if (currentToken) {
                    tokens.push({ type: 'text', content: currentToken });
                    currentToken = '';
                }
                tokens.push({ type: 'comment', content: line.slice(i) });
                break;
            }

            // Strings
            if (char === '"' || char === "'") {
                if (currentToken) {
                    tokens.push({ type: 'text', content: currentToken });
                    currentToken = '';
                }

                const quote = char;
                let stringContent = quote;
                let j = i + 1;

                while (j < line.length && line[j] !== quote) {
                    stringContent += line[j];
                    if (line[j] === '\\' && j + 1 < line.length) {
                        j++;
                        stringContent += line[j];
                    }
                    j++;
                }

                if (j < line.length) {
                    stringContent += quote;
                }

                tokens.push({ type: 'string', content: stringContent });
                i = j;
            }
            // Numbers
            else if (/\d/.test(char) && !/\w/.test(line[i - 1] || '')) {
                if (currentToken) {
                    tokens.push({ type: 'text', content: currentToken });
                    currentToken = '';
                }

                let number = '';
                while (i < line.length && /[\d.]/.test(line[i])) {
                    number += line[i];
                    i++;
                }

                tokens.push({ type: 'number', content: number });
                i--;
            }
            // Keywords (basic)
            else if (/\w/.test(char)) {
                currentToken += char;

                if (i === line.length - 1 || !/\w/.test(line[i + 1])) {
                    const keywords = getKeywords(language);
                    if (keywords.includes(currentToken)) {
                        tokens.push({ type: 'keyword', content: currentToken });
                    } else {
                        tokens.push({ type: 'text', content: currentToken });
                    }
                    currentToken = '';
                }
            }
            else {
                currentToken += char;
            }

            i++;
        }

        if (currentToken) {
            tokens.push({ type: 'text', content: currentToken });
        }

        return tokens;
    });

    return highlightedLines;
};

const getKeywords = (language: string): string[] => {
    const keywordMap: Record<string, string[]> = {
        javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'static', 'true', 'false', 'null', 'undefined'],
        typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'import', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'static', 'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum', 'public', 'private', 'protected', 'readonly'],
        python: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'lambda', 'global', 'nonlocal'],
        java: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'class', 'interface', 'extends', 'implements', 'if', 'else', 'for', 'while', 'return', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'true', 'false', 'null', 'void', 'int', 'String', 'boolean', 'double', 'float', 'long', 'short', 'char', 'byte'],
        go: ['package', 'import', 'func', 'var', 'const', 'type', 'struct', 'interface', 'if', 'else', 'for', 'range', 'return', 'go', 'defer', 'select', 'case', 'default', 'switch', 'break', 'continue', 'fallthrough', 'true', 'false', 'nil', 'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover'],
        rust: ['fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'impl', 'trait', 'if', 'else', 'match', 'for', 'while', 'loop', 'return', 'break', 'continue', 'true', 'false', 'Some', 'None', 'Ok', 'Err', 'pub', 'use', 'mod', 'crate', 'super', 'self', 'Self', 'where', 'move', 'ref', 'mut', 'unsafe', 'extern', 'as', 'dyn'],
        html: ['html', 'head', 'body', 'title', 'meta', 'link', 'script', 'style', 'div', 'span', 'p', 'a', 'img', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'form', 'input', 'button', 'textarea', 'select', 'option', 'header', 'footer', 'nav', 'section', 'article', 'aside', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        css: ['color', 'background', 'font', 'margin', 'padding', 'border', 'width', 'height', 'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear', 'overflow', 'visibility', 'opacity', 'z-index', 'flex', 'grid', 'animation', 'transition', 'transform', 'box-shadow', 'text-align', 'text-decoration', 'line-height', 'font-size', 'font-weight', 'font-family'],
    };

    const lang = language.toLowerCase();
    return keywordMap[lang] || keywordMap[lang.replace(/[sx]$/, '')] || [];
};

export function CodeRenderer({ content, language = 'text', showLineNumbers = true, style }: CodeRendererProps) {
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';
    const theme = Colors[colorScheme ?? 'light'];

    const codeLines = useMemo(() => {
        if (!content) return [];

        const highlightedLines = highlightSyntax(content, language, isDark);

        return highlightedLines.map((line, index) => ({
            number: index + 1,
            tokens: line,
            key: `line-${index}`
        }));
    }, [content, language, isDark]);

    const getTokenColor = (tokenType: string) => {
        const colors = {
            keyword: isDark ? '#569CD6' : '#0000FF',
            string: isDark ? '#CE9178' : '#A31515',
            comment: isDark ? '#6A9955' : '#008000',
            number: isDark ? '#B5CEA8' : '#098658',
            text: theme.foreground,
        };
        return colors[tokenType as keyof typeof colors] || theme.foreground;
    };

    const renderTokens = (tokens: any[]) => {
        return tokens.map((token, index) => (
            <Text
                key={index}
                style={{
                    color: getTokenColor(token.type),
                    fontFamily: 'monospace',
                    fontSize: 12,
                }}
            >
                {token.content}
            </Text>
        ));
    };

    const renderCodeLine = ({ item, index }: { item: any; index: number }) => (
        <View style={{
            flexDirection: 'row',
            minHeight: 20,
            alignItems: 'flex-start',
        }}>
            {showLineNumbers && (
                <View style={{
                    paddingHorizontal: 12,
                    paddingVertical: 2,
                    minWidth: 50,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}>
                    <Text style={{
                        fontSize: 11,
                        color: theme.mutedForeground,
                        fontFamily: 'monospace',
                    }}>
                        {item.number}
                    </Text>
                </View>
            )}
            <View style={{
                flex: 1,
                paddingHorizontal: 12,
                paddingVertical: 2,
                justifyContent: 'center',
            }}>
                <Text style={{ lineHeight: 16 }}>
                    {item.tokens.length > 0 ? renderTokens(item.tokens) : ' '}
                </Text>
            </View>
        </View>
    );

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            {showLineNumbers && (
                <View style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 50,
                    backgroundColor: theme.muted,
                    borderRightWidth: 1,
                    borderRightColor: theme.border,
                    zIndex: 0,
                }} />
            )}
            <FlatList
                data={codeLines}
                renderItem={renderCodeLine}
                keyExtractor={(item) => item.key}
                showsVerticalScrollIndicator={true}
                style={{ flex: 1 }}
                initialNumToRender={50}
                maxToRenderPerBatch={25}
                windowSize={10}
                removeClippedSubviews={true}
                getItemLayout={(data, index) => ({
                    length: 20,
                    offset: 20 * index,
                    index,
                })}
            />
        </View>
    );
} 