import { Linking, ScrollView, Text, View } from 'react-native';
import { Colors } from '../../constants/Colors';
import { useColorScheme } from '../../hooks/useColorScheme';
import { CodeRenderer } from './CodeRenderer';

interface MarkdownRendererProps {
    content: string;
    style?: any;
    noScrollView?: boolean;
}

// Process Unicode escape sequences in content
const processUnicodeContent = (content: string): string => {
    if (!content) return '';

    // Process \uXXXX Unicode escape sequences (BMP characters)
    const bmpProcessed = content.replace(
        /\\u([0-9a-fA-F]{4})/g,
        (_, codePoint) => {
            return String.fromCharCode(parseInt(codePoint, 16));
        }
    );

    // Process \uXXXXXXXX Unicode escape sequences (supplementary plane characters)
    return bmpProcessed.replace(/\\u([0-9a-fA-F]{8})/g, (_, codePoint) => {
        const highSurrogate = parseInt(codePoint.substring(0, 4), 16);
        const lowSurrogate = parseInt(codePoint.substring(4, 8), 16);
        return String.fromCharCode(highSurrogate, lowSurrogate);
    });
};

export function MarkdownRenderer({ content, style, noScrollView = false }: MarkdownRendererProps) {
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';
    const theme = Colors[colorScheme ?? 'light'];

    // Process Unicode escape sequences in the content
    const processedContent = processUnicodeContent(content);

    // Enhanced markdown parser for React Native
    const parseMarkdown = (text: string) => {
        if (!text) return [];

        const lines = text.split('\n');
        const elements: any[] = [];
        let currentIndex = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Skip empty lines
            if (!trimmedLine) {
                elements.push({
                    type: 'br',
                    content: '',
                    key: `br-${currentIndex++}`
                });
                continue;
            }

            // Headers
            if (trimmedLine.startsWith('# ')) {
                elements.push({
                    type: 'h1',
                    content: trimmedLine.slice(2),
                    key: `h1-${currentIndex++}`
                });
            } else if (trimmedLine.startsWith('## ')) {
                elements.push({
                    type: 'h2',
                    content: trimmedLine.slice(3),
                    key: `h2-${currentIndex++}`
                });
            } else if (trimmedLine.startsWith('### ')) {
                elements.push({
                    type: 'h3',
                    content: trimmedLine.slice(4),
                    key: `h3-${currentIndex++}`
                });
            } else if (trimmedLine.startsWith('#### ')) {
                elements.push({
                    type: 'h4',
                    content: trimmedLine.slice(5),
                    key: `h4-${currentIndex++}`
                });
            } else if (trimmedLine.startsWith('##### ')) {
                elements.push({
                    type: 'h5',
                    content: trimmedLine.slice(6),
                    key: `h5-${currentIndex++}`
                });
            } else if (trimmedLine.startsWith('###### ')) {
                elements.push({
                    type: 'h6',
                    content: trimmedLine.slice(7),
                    key: `h6-${currentIndex++}`
                });
            }
            // Code blocks
            else if (trimmedLine.startsWith('```')) {
                const language = trimmedLine.slice(3).trim();
                const codeLines = [];
                let j = i + 1;
                while (j < lines.length && !lines[j].trim().startsWith('```')) {
                    codeLines.push(lines[j]);
                    j++;
                }
                elements.push({
                    type: 'code',
                    content: codeLines.join('\n'),
                    language: language,
                    key: `code-${currentIndex++}`
                });
                i = j; // Skip to after the closing ```
            }
            // Lists
            else if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
                elements.push({
                    type: 'li',
                    content: trimmedLine.slice(2),
                    key: `li-${currentIndex++}`
                });
            }
            // Numbered lists
            else if (/^\d+\.\s/.test(trimmedLine)) {
                elements.push({
                    type: 'ol',
                    content: trimmedLine.replace(/^\d+\.\s/, ''),
                    key: `ol-${currentIndex++}`
                });
            }
            // Blockquotes
            else if (trimmedLine.startsWith('> ')) {
                elements.push({
                    type: 'blockquote',
                    content: trimmedLine.slice(2),
                    key: `quote-${currentIndex++}`
                });
            }
            // Horizontal rules
            else if (trimmedLine === '---' || trimmedLine === '***' || trimmedLine === '___') {
                elements.push({
                    type: 'hr',
                    content: '',
                    key: `hr-${currentIndex++}`
                });
            }
            // Tables
            else if (trimmedLine.includes('|') && trimmedLine.split('|').length > 2) {
                const tableCells = trimmedLine.split('|').map(cell => cell.trim()).filter(cell => cell);
                elements.push({
                    type: 'table-row',
                    content: tableCells,
                    key: `table-${currentIndex++}`
                });
            }
            // Regular paragraphs
            else {
                elements.push({
                    type: 'p',
                    content: trimmedLine,
                    key: `p-${currentIndex++}`
                });
            }
        }

        return elements;
    };

    const renderInlineFormatting = (text: string) => {
        if (!text) return [];

        const parts = [];
        let current = '';
        let i = 0;

        while (i < text.length) {
            const char = text[i];

            // Bold **text**
            if (char === '*' && text[i + 1] === '*') {
                if (current) {
                    parts.push({ type: 'text', content: current });
                    current = '';
                }

                let j = i + 2;
                let boldText = '';
                while (j < text.length - 1 && !(text[j] === '*' && text[j + 1] === '*')) {
                    boldText += text[j];
                    j++;
                }

                if (j < text.length - 1) {
                    parts.push({ type: 'bold', content: boldText });
                    i = j + 2;
                } else {
                    current += char;
                    i++;
                }
            }
            // Italic *text*
            else if (char === '*' && text[i + 1] !== '*') {
                if (current) {
                    parts.push({ type: 'text', content: current });
                    current = '';
                }

                let j = i + 1;
                let italicText = '';
                while (j < text.length && text[j] !== '*') {
                    italicText += text[j];
                    j++;
                }

                if (j < text.length) {
                    parts.push({ type: 'italic', content: italicText });
                    i = j + 1;
                } else {
                    current += char;
                    i++;
                }
            }
            // Inline code `text`
            else if (char === '`') {
                if (current) {
                    parts.push({ type: 'text', content: current });
                    current = '';
                }

                let j = i + 1;
                let codeText = '';
                while (j < text.length && text[j] !== '`') {
                    codeText += text[j];
                    j++;
                }

                if (j < text.length) {
                    parts.push({ type: 'code', content: codeText });
                    i = j + 1;
                } else {
                    current += char;
                    i++;
                }
            }
            // Links [text](url)
            else if (char === '[') {
                if (current) {
                    parts.push({ type: 'text', content: current });
                    current = '';
                }

                let j = i + 1;
                let linkText = '';
                while (j < text.length && text[j] !== ']') {
                    linkText += text[j];
                    j++;
                }

                if (j < text.length && text[j + 1] === '(') {
                    let k = j + 2;
                    let linkUrl = '';
                    while (k < text.length && text[k] !== ')') {
                        linkUrl += text[k];
                        k++;
                    }

                    if (k < text.length) {
                        parts.push({ type: 'link', content: linkText, url: linkUrl });
                        i = k + 1;
                    } else {
                        current += char;
                        i++;
                    }
                } else {
                    current += char;
                    i++;
                }
            }
            else {
                current += char;
                i++;
            }
        }

        if (current) {
            parts.push({ type: 'text', content: current });
        }

        return parts;
    };

    const renderInlineElements = (parts: any[]) => {
        return parts.map((part, index) => {
            switch (part.type) {
                case 'bold':
                    return (
                        <Text key={index} style={{ fontWeight: 'bold' }}>
                            {part.content}
                        </Text>
                    );
                case 'italic':
                    return (
                        <Text key={index} style={{ fontStyle: 'italic' }}>
                            {part.content}
                        </Text>
                    );
                case 'code':
                    return (
                        <Text key={index} style={{
                            fontFamily: 'monospace',
                            backgroundColor: isDark ? '#333' : '#f5f5f5',
                            paddingHorizontal: 4,
                            paddingVertical: 2,
                            borderRadius: 2,
                            fontSize: 12
                        }}>
                            {part.content}
                        </Text>
                    );
                case 'link':
                    return (
                        <Text
                            key={index}
                            style={{ color: '#007AFF', textDecorationLine: 'underline' }}
                            onPress={() => Linking.openURL(part.url)}
                        >
                            {part.content}
                        </Text>
                    );
                default:
                    return part.content;
            }
        });
    };

    const renderElement = (element: any) => {
        const commonTextStyle = {
            color: theme.foreground,
            marginBottom: 8,
        };

        switch (element.type) {
            case 'h1':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 24, fontWeight: 'bold', marginBottom: 16, marginTop: 16 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'h2':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 20, fontWeight: 'bold', marginBottom: 12, marginTop: 12 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'h3':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 18, fontWeight: 'bold', marginBottom: 10, marginTop: 10 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'h4':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 16, fontWeight: 'bold', marginBottom: 8, marginTop: 8 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'h5':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 14, fontWeight: 'bold', marginBottom: 6, marginTop: 6 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'h6':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 12, fontWeight: 'bold', marginBottom: 4, marginTop: 4 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'p':
                return (
                    <Text key={element.key} style={[
                        commonTextStyle,
                        { fontSize: 14, lineHeight: 20, marginBottom: 8 }
                    ]}>
                        {renderInlineElements(renderInlineFormatting(element.content))}
                    </Text>
                );
            case 'li':
                return (
                    <View key={element.key} style={{ flexDirection: 'row', marginBottom: 4 }}>
                        <Text style={[commonTextStyle, { fontSize: 14, marginRight: 8, marginBottom: 0 }]}>•</Text>
                        <Text style={[commonTextStyle, { fontSize: 14, flex: 1, marginBottom: 0 }]}>
                            {renderInlineElements(renderInlineFormatting(element.content))}
                        </Text>
                    </View>
                );
            case 'ol':
                return (
                    <View key={element.key} style={{ flexDirection: 'row', marginBottom: 4 }}>
                        <Text style={[commonTextStyle, { fontSize: 14, marginRight: 8, marginBottom: 0 }]}>1.</Text>
                        <Text style={[commonTextStyle, { fontSize: 14, flex: 1, marginBottom: 0 }]}>
                            {renderInlineElements(renderInlineFormatting(element.content))}
                        </Text>
                    </View>
                );
            case 'blockquote':
                return (
                    <View key={element.key} style={{
                        borderLeftWidth: 4,
                        borderLeftColor: isDark ? '#555' : '#ddd',
                        backgroundColor: isDark ? '#2a2a2a' : '#f8f9fa',
                        paddingLeft: 16,
                        paddingVertical: 12,
                        marginVertical: 8,
                        borderRadius: 4
                    }}>
                        <Text style={[commonTextStyle, { fontSize: 14, fontStyle: 'italic', marginBottom: 0 }]}>
                            {renderInlineElements(renderInlineFormatting(element.content))}
                        </Text>
                    </View>
                );
            case 'code':
                if (noScrollView) {
                    return (
                        <View key={element.key} style={{
                            marginVertical: 8,
                            backgroundColor: isDark ? '#2a2a2a' : '#f8f9fa',
                            borderRadius: 8,
                            padding: 16,
                            borderWidth: 1,
                            borderColor: isDark ? '#404040' : '#e9ecef'
                        }}>
                            <Text style={{
                                fontFamily: 'monospace',
                                fontSize: 14,
                                color: theme.foreground,
                                lineHeight: 20
                            }}>
                                {element.content}
                            </Text>
                        </View>
                    );
                }
                return (
                    <View key={element.key} style={{ marginVertical: 8 }}>
                        <CodeRenderer
                            content={element.content}
                            language={element.language}
                            showLineNumbers={false}
                        />
                    </View>
                );
            case 'hr':
                return (
                    <View key={element.key} style={{
                        height: 1,
                        backgroundColor: isDark ? '#404040' : '#e9ecef',
                        marginVertical: 16
                    }} />
                );
            case 'table-row':
                return (
                    <View key={element.key} style={{
                        flexDirection: 'row',
                        borderBottomWidth: 1,
                        borderBottomColor: isDark ? '#404040' : '#e9ecef',
                        paddingVertical: 8,
                        backgroundColor: isDark ? '#2a2a2a' : '#f8f9fa'
                    }}>
                        {element.content.map((cell: string, index: number) => (
                            <View key={index} style={{
                                flex: 1,
                                paddingHorizontal: 8,
                                borderRightWidth: index < element.content.length - 1 ? 1 : 0,
                                borderRightColor: isDark ? '#404040' : '#e9ecef'
                            }}>
                                <Text style={[commonTextStyle, { fontSize: 12, marginBottom: 0 }]}>
                                    {renderInlineElements(renderInlineFormatting(cell))}
                                </Text>
                            </View>
                        ))}
                    </View>
                );
            case 'br':
                return <View key={element.key} style={{ height: 8 }} />;
            default:
                return null;
        }
    };

    const elements = parseMarkdown(processedContent);

    const renderContent = () => elements.map(renderElement);

    if (noScrollView) {
        return (
            <View style={[{ flex: 1, backgroundColor: theme.background, padding: 16 }, style]}>
                {renderContent()}
            </View>
        );
    }

    return (
        <ScrollView
            style={[{ flex: 1, backgroundColor: theme.background }, style]}
            contentContainerStyle={{ padding: 16 }}
            showsVerticalScrollIndicator={true}
        >
            {renderContent()}
        </ScrollView>
    );
} 