import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Phone, User } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractMakeCallData, formatPhoneNumber, statusConfig } from './_utils';
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

export function MakeCallToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const data = extractMakeCallData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (data.status !== 'failed');

  const status = data.status;
  const statusInfo = statusConfig[status as keyof typeof statusConfig] || statusConfig.queued;

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
          rightContent: <StatusBadge variant="streaming" label="Initiating" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Initiating Call"
            filePath={data.phone_number ? formatPhoneNumber(data.phone_number) : undefined}
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
          {data.phone_number && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {formatPhoneNumber(data.phone_number)}
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
            <View className="flex-row items-center gap-2">
              <Icon as={User} size={16} className="text-muted-foreground" />
              <Text className="text-sm font-roobert-medium text-muted-foreground">
                Call ID
              </Text>
            </View>
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {data.call_id}
            </Text>
          </View>

          {data.first_message && (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                First Message
              </Text>
              <View className="bg-muted/10 dark:bg-muted/80 rounded-xl p-4 border border-border">
                <Text className="text-sm font-roobert text-foreground" selectable>
                  {data.first_message}
                </Text>
              </View>
            </View>
          )}

          {data.message && (
            <View className={`rounded-xl p-4 border ${status === 'failed' ? 'bg-red-500/10 border-red-500/20' : 'bg-muted/50 border-border'}`}>
              <Text className={`text-sm font-roobert ${status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                {data.message}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
