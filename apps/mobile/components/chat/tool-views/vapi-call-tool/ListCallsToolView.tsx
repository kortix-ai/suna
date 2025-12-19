import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Phone, Clock, Calendar } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractListCallsData, formatPhoneNumber, formatDuration, statusConfig } from './_utils';
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

export function ListCallsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const data = extractListCallsData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

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
          rightContent: <StatusBadge variant="streaming" label="Fetching" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Fetching Calls"
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (data.calls.length === 0) {
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
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Phone} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Calls Found
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            No call history available
          </Text>
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
          <Text className="text-xs text-muted-foreground">
            {data.calls.length} {data.calls.length === 1 ? 'call' : 'calls'} found
          </Text>
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
          <View className="gap-3">
            {data.calls.map((call, idx) => {
              const statusInfo = statusConfig[call.status as keyof typeof statusConfig] || statusConfig.queued;

              return (
                <View key={call.call_id || idx} className="bg-card border border-border rounded-xl p-4 gap-3">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-base font-roobert-semibold text-foreground">
                      {formatPhoneNumber(call.phone_number)}
                    </Text>
                    <View className={`px-2 py-1 rounded-full ${statusInfo.bg}`}>
                      <Text className={`text-xs font-roobert-medium ${statusInfo.color}`}>
                        {statusInfo.label}
                      </Text>
                    </View>
                  </View>

                  <View className="flex-row flex-wrap gap-2">
                    {call.duration_seconds !== undefined && (
                      <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                        <Icon as={Clock} size={12} className="text-muted-foreground" />
                        <Text className="text-xs font-roobert text-muted-foreground">
                          {formatDuration(call.duration_seconds)}
                        </Text>
                      </View>
                    )}

                    {call.started_at && (
                      <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                        <Icon as={Calendar} size={12} className="text-muted-foreground" />
                        <Text className="text-xs font-roobert text-muted-foreground">
                          {new Date(call.started_at).toLocaleString()}
                        </Text>
                      </View>
                    )}
                  </View>

                  <View className="bg-muted/20 p-2 rounded">
                    <Text className="text-xs font-roobert-mono text-muted-foreground" selectable>
                      {call.call_id}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
