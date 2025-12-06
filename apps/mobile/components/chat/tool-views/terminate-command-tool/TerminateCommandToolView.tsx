import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { StopCircle, Terminal, Power } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractTerminateCommandData } from './_utils';
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

export function TerminateCommandToolView({ toolCall, toolResult, isSuccess = true, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { sessionName, output, success } = extractTerminateCommandData(toolCall, toolResult, isSuccess);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const lines = output ? output.split('\n') : [];

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
          rightContent: <StatusBadge variant="streaming" label="Terminating" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Terminating Session"
            filePath={sessionName || undefined}
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
            label={actualIsSuccess ? 'Terminated' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {sessionName && (
            <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
              {sessionName}
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
          <View className="bg-card border border-border rounded-2xl p-4">
            <View className="flex-row items-center gap-2 mb-3">
              <Icon as={Power} size={16} className="text-muted-foreground" />
              <Text className="text-sm font-roobert-medium text-foreground/70">Session</Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Text className="text-destructive" selectable>●</Text>
              <Text className="text-sm font-roobert-mono text-foreground flex-1" selectable>
                {sessionName || 'Unknown'}
              </Text>
            </View>
          </View>

          {output && (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Result
              </Text>
              <View className="bg-card border border-border rounded-2xl overflow-hidden">
                <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={true}>
                  <View className="p-3">
                    <CodeRenderer
                      code={output}
                      language="bash"
                      showLineNumbers={false}
                    />
                  </View>
                </ScrollView>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
