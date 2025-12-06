import React from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import { atomOneDark, atomOneLight } from 'react-syntax-highlighter/dist/esm/styles/hljs';

interface CodeRendererProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  className?: string;
}

export function CodeRenderer({
  code,
  language = 'text',
  showLineNumbers = false,
  className = '',
}: CodeRendererProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // For simple text or unsupported languages, use plain text display
  if (!language || language === 'text' || !SyntaxHighlighter) {
    const lines = code.split('\n');
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className={`bg-card border border-border rounded-xl p-4 ${className}`}
      >
        <View>
          {lines.map((line, idx) => (
            <View key={idx} className="flex-row">
              {showLineNumbers && (
                <Text className="text-xs text-muted-foreground mr-4 w-8 text-right">
                  {idx + 1}
                </Text>
              )}
              <Text className="text-sm font-roobert-mono text-foreground/80 flex-1">
                {line || ' '}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }

  // Use syntax highlighter for supported languages
  try {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className={`bg-card border border-border rounded-xl ${className}`}
      >
        <SyntaxHighlighter
          language={language}
          style={isDark ? atomOneDark : atomOneLight}
          customStyle={{
            padding: 16,
            margin: 0,
            backgroundColor: 'transparent',
          }}
          showLineNumbers={showLineNumbers}
          lineNumberStyle={{
            color: isDark ? '#666' : '#999',
            marginRight: 16,
          }}
        >
          {code}
        </SyntaxHighlighter>
      </ScrollView>
    );
  } catch (error) {
    // Fallback to plain text if syntax highlighting fails
    const lines = code.split('\n');
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className={`bg-card border border-border rounded-xl p-4 ${className}`}
      >
        <View>
          {lines.map((line, idx) => (
            <Text
              key={idx}
              className="text-sm font-roobert-mono text-foreground/80"
            >
              {line || ' '}
            </Text>
          ))}
        </View>
      </ScrollView>
    );
  }
}

