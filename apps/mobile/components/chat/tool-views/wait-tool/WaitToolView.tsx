import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, Timer } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWaitData, formatDuration } from './_utils';
import { ToolViewCard, StatusBadge } from '../shared';
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

export function WaitToolView({ toolCall, toolResult, isStreaming, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { seconds, success } = extractWaitData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: toolMetadata.subtitle.toUpperCase(),
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={isStreaming ? 'Waiting' : 'Completed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <Text className="text-xs text-muted-foreground">
            Duration: {formatDuration(seconds)}
          </Text>
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <View className="flex-1 w-full px-4 py-12">
        <View className="flex-1 items-center justify-center">
          <View className="bg-muted/10 rounded-2xl items-center justify-center mb-6" style={{ width: 96, height: 96 }}>
            <Icon as={Timer} size={48} className="text-muted-foreground" />
          </View>

          <Text className="text-5xl font-roobert-semibold text-foreground mb-3">
            {formatDuration(seconds)}
          </Text>

          <Text className="text-sm font-roobert text-muted-foreground text-center max-w-sm mb-4">
            {isStreaming
              ? 'The system is currently pausing execution for the specified duration.'
              : `The system paused execution for ${formatDuration(seconds)} as requested.`
            }
          </Text>

          {seconds > 0 && (
            <View className="bg-muted/30 rounded-full px-4 py-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground">
                {isStreaming ? 'Please wait...' : 'Wait completed successfully'}
              </Text>
            </View>
          )}
        </View>
      </View>
    </ToolViewCard>
  );
}
