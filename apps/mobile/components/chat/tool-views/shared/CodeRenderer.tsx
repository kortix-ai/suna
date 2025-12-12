import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';

interface CodeRendererProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  className?: string;
}

// Basic syntax highlighting colors for common languages
const getSyntaxColors = (isDark: boolean) => ({
  keyword: isDark ? '#c792ea' : '#d73a49',
  string: isDark ? '#c3e88d' : '#032f62',
  comment: isDark ? '#546e7a' : '#6a737d',
  number: isDark ? '#f78c6c' : '#005cc5',
  function: isDark ? '#82aaff' : '#6f42c1',
  variable: isDark ? '#eeffff' : '#e36209',
  operator: isDark ? '#89ddff' : '#d73a49',
  default: isDark ? '#eeffff' : '#24292e',
});

// Simple tokenizer for basic syntax highlighting
function tokenizeCode(code: string, language: string, isDark: boolean): Array<{ text: string; color: string }> {
  const colors = getSyntaxColors(isDark);
  const tokens: Array<{ text: string; color: string }> = [];
  
  // Common keywords for various languages
  const keywords = [
    'function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return',
    'class', 'import', 'export', 'from', 'async', 'await', 'try', 'catch',
    'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import',
    'public', 'private', 'protected', 'static', 'void', 'int', 'string',
  ];
  
  // Simple regex patterns
  const patterns = [
    { regex: /("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g, color: colors.string }, // Strings
    { regex: /(\/\/.*|\/\*[\s\S]*?\*\/)/g, color: colors.comment }, // Comments
    { regex: /\b(\d+\.?\d*)\b/g, color: colors.number }, // Numbers
    { regex: new RegExp(`\\b(${keywords.join('|')})\\b`, 'gi'), color: colors.keyword }, // Keywords
  ];
  
  // For now, just return plain text with default color
  // More sophisticated highlighting can be added later
  return [{ text: code, color: colors.default }];
}

export function CodeRenderer({
  code,
  language = 'text',
  showLineNumbers = false,
  className = '',
}: CodeRendererProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const lines = useMemo(() => code.split('\n'), [code]);
  const colors = getSyntaxColors(isDark);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className={`bg-card border border-border rounded-xl ${className}`}
      style={{
        backgroundColor: isDark ? '#1e1e1e' : '#ffffff',
        borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
      }}
    >
      <View style={{ padding: 16 }}>
        {lines.map((line, idx) => (
          <View key={idx} className="flex-row" style={{ minHeight: 20 }}>
            {showLineNumbers && (
              <View style={{ width: 40, marginRight: 16, alignItems: 'flex-end' }}>
                <Text
                  style={{
                    fontSize: 12,
                    fontFamily: 'monospace',
                    color: isDark ? '#666' : '#999',
                  }}
                >
                  {idx + 1}
                </Text>
              </View>
            )}
            <View className="flex-1" style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 13,
                  fontFamily: 'monospace',
                  color: colors.default,
                  lineHeight: 20,
                }}
                selectable
              >
                {line || ' '}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

