import React, { useMemo } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';

interface JsonRendererProps {
  content: string;
  className?: string;
}

export function JsonRenderer({ content }: JsonRendererProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const processUnicodeContent = (text: string): string => {
    return text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\r\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '  ');
  };

  const formattedJson = useMemo(() => {
    const processed = processUnicodeContent(content);
    try {
      const parsed = JSON.parse(processed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // If parsing fails, return the processed content as-is
      return processed;
    }
  }, [content]);

  const lines = useMemo(() => formattedJson.split('\n'), [formattedJson]);

  return (
    <ScrollView
      className="flex-1"
      showsVerticalScrollIndicator={true}
      style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
    >
      <View className="px-4 py-2">
        <View className="bg-card border border-border rounded-xl overflow-hidden">
          <View className="px-4 py-2 border-b border-border">
            <Text className="text-xs font-roobert-medium text-primary opacity-50 uppercase tracking-wider">
              JSON
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ backgroundColor: isDark ? '#1e1e1e' : '#ffffff' }}
          >
            <View style={{ padding: 12 }}>
              {lines.map((line, idx) => (
                <Text
                  key={idx}
                  style={{
                    fontSize: 13,
                    fontFamily: 'monospace',
                    color: isDark ? '#eeffff' : '#24292e',
                    lineHeight: 20,
                  }}
                  selectable
                >
                  {line || ' '}
                </Text>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </ScrollView>
  );
}

