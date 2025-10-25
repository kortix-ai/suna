import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const processUnicodeContent = (text: string): string => {
    return text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\r\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '  ');
  };

  const renderMarkdown = (text: string) => {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let codeBlockLang = '';
    let inList = false;
    let listItems: string[] = [];

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          <View key={elements.length} className="mb-4">
            {listItems.map((item, idx) => (
              <View key={idx} className="flex-row items-start mb-2">
                <Text className="text-sm font-roobert text-foreground/60 mr-2">•</Text>
                <Text className="text-sm font-roobert text-foreground/90 flex-1">{item}</Text>
              </View>
            ))}
          </View>
        );
        listItems = [];
        inList = false;
      }
    };

    lines.forEach((line, index) => {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <View key={index} className="bg-muted/30 border border-border rounded-xl p-4 mb-4">
              <Text className="text-xs font-mono text-foreground/80 leading-5">
                {codeBlockContent.join('\n')}
              </Text>
            </View>
          );
          codeBlockContent = [];
          codeBlockLang = '';
          inCodeBlock = false;
        } else {
          flushList();
          inCodeBlock = true;
          codeBlockLang = line.slice(3).trim();
        }
      } else if (inCodeBlock) {
        codeBlockContent.push(line);
      } else if (line.startsWith('#')) {
        flushList();
        const level = line.match(/^#+/)?.[0].length || 1;
        const text = line.replace(/^#+\s*/, '');
        
        const fontSize = level === 1 ? 'text-2xl' : level === 2 ? 'text-xl' : level === 3 ? 'text-lg' : 'text-base';
        const marginBottom = level <= 2 ? 'mb-4' : 'mb-3';
        
        elements.push(
          <Text key={index} className={`font-roobert-semibold text-foreground ${fontSize} ${marginBottom}`}>
            {text}
          </Text>
        );
      } else if (line.match(/^[-*+]\s+/)) {
        const item = line.replace(/^[-*+]\s+/, '');
        listItems.push(item);
        inList = true;
      } else if (line.match(/^\d+\.\s+/)) {
        const item = line.replace(/^\d+\.\s+/, '');
        listItems.push(item);
        inList = true;
      } else if (line.startsWith('>')) {
        flushList();
        const text = line.replace(/^>\s*/, '');
        elements.push(
          <View key={index} className="border-l-4 border-primary/30 pl-4 mb-4">
            <Text className="text-sm font-roobert text-foreground/80 italic">
              {text}
            </Text>
          </View>
        );
      } else if (line.trim() === '') {
        flushList();
        elements.push(<View key={index} className="h-4" />);
      } else {
        flushList();
        
        let processedLine = line;
        
        processedLine = processedLine.replace(/\*\*(.*?)\*\*/g, '$1');
        processedLine = processedLine.replace(/\*(.*?)\*/g, '$1');
        processedLine = processedLine.replace(/`([^`]+)`/g, '$1');
        processedLine = processedLine.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        
        elements.push(
          <Text key={index} className="text-sm font-roobert text-foreground/90 leading-6 mb-2">
            {processedLine}
          </Text>
        );
      }
    });

    flushList();

    if (inCodeBlock && codeBlockContent.length > 0) {
      elements.push(
        <View key={elements.length} className="bg-muted/30 border border-border rounded-xl p-4 mb-4">
          <Text className="text-xs font-mono text-foreground/80 leading-5">
            {codeBlockContent.join('\n')}
          </Text>
        </View>
      );
    }

    return elements;
  };

  const processedContent = processUnicodeContent(content);

  return (
    <View className="px-4 py-2">
      {renderMarkdown(processedContent)}
    </View>
  );
}
