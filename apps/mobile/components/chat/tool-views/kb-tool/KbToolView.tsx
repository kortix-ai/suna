import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Database, FileText, Folder, File } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractKbData } from './_utils';
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

export function KbToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const data = extractKbData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

  const toolName = toolCall.function_name || '';
  const isInit = toolName.includes('init');
  const isSearch = toolName.includes('search');
  const isList = toolName.includes('ls') || toolName.includes('list');
  const isSync = toolName.includes('sync');

  const totalItems = (data.files?.length || 0) + (data.folders?.length || 0) + (data.items?.length || 0);

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
            title={
              isInit ? 'Initializing KB' : isSearch ? 'Searching KB' : isSync ? 'Syncing KB' : 'Processing KB'
            }
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
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={totalItems > 0 ? `${totalItems} items` : actualIsSuccess ? 'Completed' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {data.path && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {data.path}
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
          {data.message && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Message
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert text-foreground" selectable>
                  {data.message}
                </Text>
              </View>
            </View>
          )}

          {data.path && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Path
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert text-foreground" selectable>
                  {data.path}
                </Text>
              </View>
            </View>
          )}

          {totalItems > 0 && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Contents ({totalItems})
              </Text>

              {data.folders && data.folders.length > 0 && (
                <View className="gap-2">
                  {data.folders.map((folder: any, idx: number) => (
                    <View key={idx} className="bg-card border border-border rounded-2xl p-4 flex-row items-center gap-3">
                      <Icon as={Folder} size={18} className="text-primary" />
                      <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={1}>
                        {folder.name || folder}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {data.files && data.files.length > 0 && (
                <View className="gap-2">
                  {data.files.map((file: any, idx: number) => (
                    <View key={idx} className="bg-card border border-border rounded-2xl p-4 flex-row items-center gap-3">
                      <Icon as={FileText} size={18} className="text-primary" />
                      <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={2}>
                        {file.name || file.path || file}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {data.items && data.items.length > 0 && (
                <View className="gap-2">
                  {data.items.map((item: any, idx: number) => (
                    <View key={idx} className="bg-card border border-border rounded-2xl p-4 flex-row items-center gap-3">
                      <Icon as={File} size={18} className="text-primary" />
                      <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={2}>
                        {item.name || item.path || item}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {totalItems === 0 && !data.message && (
            <View className="items-center justify-center py-12">
              <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                <Icon as={Database} size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-base font-roobert-medium text-foreground mb-1">
                No Content
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                Knowledge base operation completed with no results
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
