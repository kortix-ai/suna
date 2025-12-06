import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Terminal, Clock } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCheckCommandOutputData } from './_utils';
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

export function CheckCommandOutputToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { sessionName, output, status, success } = extractCheckCommandOutputData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const lines = output ? output.split('\n') : [];
  const isSessionRunning = status?.includes('running');

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
          rightContent: <StatusBadge variant="streaming" label="Checking" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Checking Output"
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
            label={isSessionRunning ? 'Running' : actualIsSuccess ? 'Completed' : 'Failed'}
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
          {status && (
            <View className="bg-muted/50 rounded-xl p-3 border border-border">
              <View className="flex-row items-center gap-2">
                <Icon as={Clock} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert text-muted-foreground">
                  Status: <Text className="text-foreground font-roobert-medium">{status}</Text>
                </Text>
              </View>
            </View>
          )}

          {output ? (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Output
              </Text>
              <View className="bg-card border border-border rounded-xl overflow-hidden">
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
          ) : (
            <View className="py-8 items-center">
              <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                <Icon as={Terminal} size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-base font-roobert-medium text-foreground mb-1">
                No Output
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                No output received from session
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
