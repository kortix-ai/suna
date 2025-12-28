import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Bot, Settings, Calendar, Clock } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAgentData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState, JsonViewer } from '../shared';
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

export function AgentToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

  const data = extractAgentData(toolCall, toolResult);

  const toolName = toolCall.function_name.replace(/_/g, '-');
  const isCreate = toolName.includes('create');
  const isUpdate = toolName.includes('update');
  const isTrigger = toolName.includes('trigger');
  const isList = toolName.includes('list');

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
              isCreate ? 'Creating Worker' : isUpdate ? 'Updating Worker' : isTrigger ? 'Managing Trigger' : 'Processing'
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
            label={actualIsSuccess ? 'Success' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {data.agent_id && (
            <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
              {data.agent_id}
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
            <View className="bg-muted/50 rounded-xl p-4 border border-border">
              <Text className="text-sm font-roobert text-foreground">
                {data.message}
              </Text>
            </View>
          )}

          {data.agent_id && (
            <View className="bg-card border border-border rounded-xl p-4 gap-2">
              <View className="flex-row items-center gap-2">
                <Icon as={Bot} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert-medium text-muted-foreground">
                  Worker ID
                </Text>
              </View>
              <Text className="text-sm font-roobert-mono text-foreground" selectable>
                {data.agent_id}
              </Text>
            </View>
          )}

          {data.config && (
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Icon as={Settings} size={14} className="text-muted-foreground" />
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  Configuration
                </Text>
              </View>
              <JsonViewer data={data.config} title="CONFIG" defaultExpanded={false} />
            </View>
          )}

          {data.trigger && (
            <View className="bg-card border border-border rounded-xl p-4 gap-3">
              <View className="flex-row items-center gap-2">
                <Icon as={Calendar} size={16} className="text-primary" />
                <Text className="text-base font-roobert-semibold text-foreground">
                  {data.trigger.name || 'Trigger'}
                </Text>
              </View>
              {data.trigger.schedule && (
                <View className="bg-muted/20 p-2 rounded">
                  <Text className="text-xs font-roobert-mono text-muted-foreground">
                    {data.trigger.schedule}
                  </Text>
                </View>
              )}
            </View>
          )}

          {data.triggers && data.triggers.length > 0 && (
            <View className="gap-3">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Triggers ({data.triggers.length})
              </Text>
              {data.triggers.map((trigger: any, idx: number) => (
                <View key={idx} className="bg-card border border-border rounded-xl p-3 gap-2">
                  <Text className="text-sm font-roobert-semibold text-foreground">
                    {trigger.name || `Trigger ${idx + 1}`}
                  </Text>
                  {trigger.schedule && (
                    <View className="flex-row items-center gap-2 bg-muted/20 p-2 rounded">
                      <Icon as={Clock} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert-mono text-muted-foreground flex-1">
                        {trigger.schedule}
                      </Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
