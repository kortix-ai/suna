import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileText, CheckCircle2, AlertCircle, FileType, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDocumentParserData } from './_utils';

export function DocumentParserToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { filePath, fileName, content, pageCount, success } = extractDocumentParserData(toolData);
  
  const lines = content ? content.split('\n') : [];
  const preview = lines.slice(0, 50);

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-orange-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={FileText} size={40} className="text-orange-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Parsing Document
        </Text>
        {fileName && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {fileName}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-orange-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={FileText} size={24} className="text-orange-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Document Parser
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {fileName || 'Document'}
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
            success ? 'bg-primary/10' : 'bg-destructive/10'
          }`}>
            <Icon 
              as={success ? CheckCircle2 : AlertCircle} 
              size={12} 
              className={success ? 'text-primary' : 'text-destructive'} 
            />
            <Text className={`text-xs font-roobert-medium ${
              success ? 'text-primary' : 'text-destructive'
            }`}>
              {success ? 'Parsed' : 'Failed'}
            </Text>
          </View>
        </View>

        <View className="flex-row gap-2">
          {pageCount !== null && (
            <View className="bg-muted/50 rounded-xl p-3 border border-border flex-1">
              <View className="flex-row items-center gap-2 mb-1">
                <Icon as={Hash} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert-medium text-muted-foreground">Pages</Text>
              </View>
              <Text className="text-lg font-roobert-semibold text-foreground">
                {pageCount}
              </Text>
            </View>
          )}
          {filePath && (
            <View className="bg-muted/50 rounded-xl p-3 border border-border flex-1">
              <View className="flex-row items-center gap-2 mb-1">
                <Icon as={FileType} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert-medium text-muted-foreground">Type</Text>
              </View>
              <Text className="text-lg font-roobert-semibold text-foreground uppercase">
                {filePath.split('.').pop() || 'DOC'}
              </Text>
            </View>
          )}
        </View>

        {content ? (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Content {lines.length > 50 && `(First 50 of ${lines.length} lines)`}
            </Text>
            <View className="bg-muted/50 rounded-xl p-4 border border-border">
              {preview.map((line, idx) => (
                <Text 
                  key={idx}
                  className="text-sm font-roobert text-foreground leading-6"
                  selectable
                >
                  {line || ' '}
                </Text>
              ))}
              {lines.length > 50 && (
                <Text className="text-xs font-roobert text-muted-foreground mt-3 text-center">
                  +{lines.length - 50} more lines
                </Text>
              )}
            </View>
          </View>
        ) : (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={FileText} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              No Content
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              No content extracted from document
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

