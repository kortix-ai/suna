import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, DollarSign, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWaitForCallCompletionData, formatDuration, statusConfig } from './_utils';
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

export function WaitForCallCompletionToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const data = extractWaitForCallCompletionData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

  const statusInfo = statusConfig[data.final_status as keyof typeof statusConfig] || statusConfig.completed;

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
          rightContent: <StatusBadge variant="streaming" label="Waiting" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Waiting for Call"
            subtitle="Monitoring call completion..."
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
            label={statusInfo.label}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {data.call_id && (
            <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
              {data.call_id}
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
          <View className="bg-card border border-border rounded-xl p-4 gap-3">
            <Text className="text-sm font-roobert-medium text-muted-foreground">
              Call ID
            </Text>
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {data.call_id}
            </Text>
          </View>

          <View className="flex-row gap-2">
            {data.duration_seconds !== undefined && (
              <View className="bg-muted/30 rounded-xl p-3 border border-border flex-1">
                <View className="flex-row items-center gap-2 mb-1">
                  <Icon as={Clock} size={14} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert-medium text-muted-foreground">Duration</Text>
                </View>
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {formatDuration(data.duration_seconds)}
                </Text>
              </View>
            )}

            {data.cost !== undefined && (
              <View className="bg-muted/30 rounded-xl p-3 border border-border flex-1">
                <View className="flex-row items-center gap-2 mb-1">
                  <Icon as={DollarSign} size={14} className="text-muted-foreground" />
                  <Text className="text-xs font-roobert-medium text-muted-foreground">Cost</Text>
                </View>
                <Text className="text-lg font-roobert-semibold text-foreground">
                  ${data.cost.toFixed(2)}
                </Text>
              </View>
            )}
          </View>

          {data.message && (
            <View className="bg-muted/50 rounded-xl p-4 border border-border">
              <Text className="text-sm font-roobert text-foreground">
                {data.message}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
