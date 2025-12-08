import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Table2, FileSpreadsheet, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractSheetsData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
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

export function SheetsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { filePath, fileName, action, headers, rows, success } = extractSheetsData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

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
          rightContent: <StatusBadge variant="streaming" label="Processing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Processing Sheet"
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
          {filePath && (
            <View className="bg-muted/30 rounded-xl p-3 border border-border">
              <View className="flex-row items-center gap-2 mb-1">
                <Icon as={FileSpreadsheet} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert-medium text-muted-foreground">File Path</Text>
              </View>
              <Text className="text-sm font-roobert-mono text-foreground" selectable numberOfLines={2}>
                {filePath}
              </Text>
            </View>
          )}

          {headers.length > 0 && rows.length > 0 && (
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  Preview
                </Text>
                <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                  <Icon as={Hash} size={12} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {rows.length} rows
                  </Text>
                </View>
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={true} className="border border-border rounded-xl">
                <View>
                  <View className="flex-row bg-muted/50 border-b border-border">
                    {headers.map((header, idx) => (
                      <View
                        key={idx}
                        className="px-3 py-2 border-r border-border"
                        style={{ minWidth: 120 }}
                      >
                        <Text className="text-xs font-roobert-semibold text-foreground">
                          {header}
                        </Text>
                      </View>
                    ))}
                  </View>

                  {rows.slice(0, 10).map((row, rowIdx) => (
                    <View key={rowIdx} className="flex-row border-b border-border">
                      {row.map((cell, cellIdx) => (
                        <View
                          key={cellIdx}
                          className="px-3 py-2 border-r border-border"
                          style={{ minWidth: 120 }}
                        >
                          <Text className="text-xs font-roobert text-foreground" numberOfLines={2}>
                            {String(cell ?? '')}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ))}

                  {rows.length > 10 && (
                    <View className="bg-muted/30 p-3">
                      <Text className="text-xs font-roobert text-muted-foreground text-center">
                        +{rows.length - 10} more rows
                      </Text>
                    </View>
                  )}
                </View>
              </ScrollView>
            </View>
          )}

          {!headers.length && !rows.length && filePath && (
            <View className="py-8 items-center">
              <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                <Icon as={Table2} size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-base font-roobert-medium text-foreground mb-1">
                Sheet {action}
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                No preview available
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
