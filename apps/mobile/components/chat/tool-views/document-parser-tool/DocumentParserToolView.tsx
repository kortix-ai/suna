import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileText, FileType, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDocumentParserData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState, CodeRenderer } from '../shared';
import { getToolMetadata } from '../tool-metadata';

// Utility functions
function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

export function DocumentParserToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

  const { filePath, fileName, content, pageCount, success } = extractDocumentParserData({ toolCall, toolResult });

  const lines = content ? content.split('\n') : [];
  const preview = lines.slice(0, 50);

  if (isStreaming) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Parsing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Parsing Document"
            filePath={fileName || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: toolMetadata.subtitle.toUpperCase(),
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {filePath && (
            <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
              {filePath}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
        <View className="px-4 py-4 gap-6">
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
              <View className="bg-card border border-border rounded-xl overflow-hidden">
                <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
                  <View className="p-4">
                    <CodeRenderer
                      code={preview.join('\n')}
                      language="text"
                      showLineNumbers={false}
                    />
                    {lines.length > 50 && (
                      <Text className="text-xs font-roobert text-muted-foreground mt-3 text-center">
                        +{lines.length - 50} more lines
                      </Text>
                    )}
                  </View>
                </ScrollView>
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
    </ToolViewCard>
  );
}
