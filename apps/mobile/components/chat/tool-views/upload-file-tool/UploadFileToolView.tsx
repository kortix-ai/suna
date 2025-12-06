import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Upload, FileText, HardDrive } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractUploadFileData } from './_utils';
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

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function UploadFileToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { filePath, fileName, fileSize, message, success } = extractUploadFileData({ toolCall, toolResult });

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
          rightContent: <StatusBadge variant="streaming" label="Uploading" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Uploading File"
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
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={actualIsSuccess ? 'Uploaded' : 'Failed'}
          />
        ),
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
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                File Path
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert-mono text-foreground" selectable>
                  {filePath}
                </Text>
              </View>
            </View>
          )}

          {fileSize && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                File Size
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {formatFileSize(fileSize)}
                </Text>
              </View>
            </View>
          )}

          {message && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Message
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert text-foreground" selectable>
                  {message}
                </Text>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
