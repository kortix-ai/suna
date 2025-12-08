/**
 * Generic Tool View
 *
 * Default fallback view for tools without specialized renderers
 */

import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, Wrench } from 'lucide-react-native';
import type { ToolViewProps } from './types';
import { ToolViewCard, StatusBadge, LoadingState } from './shared';
import { getToolMetadata } from './tool-metadata';

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

export function GenericToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // Defensive check - handle cases where toolCall might be undefined or missing function_name
  if (!toolCall || !toolCall.function_name) {
    return (
      <ToolViewCard
        header={{
          icon: Wrench,
          iconColor: 'text-primary',
          iconBgColor: 'bg-card',
          subtitle: '',
          title: 'Tool View Error',
          isSuccess: false,
          isStreaming: false,
        }}
      >
        <View className="p-4">
          <Text className="text-sm text-primary opacity-50">
            This tool view requires structured metadata. Please update the component to use toolCall and toolResult props.
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  const hasInput = toolCall?.arguments && Object.keys(toolCall.arguments).length > 0;
  const hasOutput = toolResult?.output !== undefined && toolResult?.output !== null;

  const formatContent = (data: any): string => {
    if (typeof data === 'string') return data;
    return JSON.stringify(data, null, 2);
  };

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: '',
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        rightContent: (
          <View className="flex-row items-center gap-2">
            {!isStreaming && (
              <StatusBadge
                variant={actualIsSuccess ? 'success' : 'error'}
                iconOnly={true}
              />
            )}
            {isStreaming && <StatusBadge variant="streaming" iconOnly={true} />}
          </View>
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2 flex-1 min-w-0">
            {!isStreaming && (hasInput || hasOutput) && (
              <View className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border border-border">
                <Icon as={Wrench} size={12} className="text-primary" />
                <Text className="text-xs font-roobert-medium text-primary">
                  Tool
                </Text>
              </View>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            <Icon as={Clock} size={12} className="text-primary opacity-50" />
            <Text className="text-xs text-primary opacity-50">
              {toolTimestamp && !isStreaming
                ? formatTimestamp(toolTimestamp)
                : assistantTimestamp
                  ? formatTimestamp(assistantTimestamp)
                  : ''}
            </Text>
          </View>
        </View>
      }
    >
      {isStreaming ? (
        <View className="flex-1 w-full">
          <LoadingState
            icon={Wrench}
            iconColor="text-primary"
            bgColor="bg-card"
            title="Executing tool"
            filePath={name}
            showProgress={true}
          />
        </View>
      ) : hasInput || hasOutput ? (
        <ScrollView
          className="flex-1 w-full"
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
        >
          <View className="p-4 gap-4">
            {hasInput && (
              <View className="gap-2">
                <Text className="text-xs font-roobert-medium text-primary opacity-60 uppercase tracking-wider px-1">
                  Input
                </Text>
                <View className="bg-card border border-border rounded-xl p-4">
                  <Text className="text-xs font-roobert-mono text-primary leading-5" selectable>
                    {formatContent(toolCall.arguments)}
                  </Text>
                </View>
              </View>
            )}

            {hasOutput && (
              <View className="gap-2">
                <Text className="text-xs font-roobert-medium text-primary opacity-60 uppercase tracking-wider px-1">
                  Output
                </Text>
                <View className="bg-card border border-border rounded-xl p-4">
                  <Text className="text-xs font-roobert-mono text-primary leading-5" selectable>
                    {formatContent(toolResult?.output)}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center py-12 px-6">
          <View className="rounded-full items-center justify-center mb-6 bg-card" style={{ width: 80, height: 80 }}>
            <Icon as={Wrench} size={40} className="text-primary opacity-50" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-primary">
            No Content Available
          </Text>
          <Text className="text-sm text-primary opacity-50 text-center max-w-md">
            This tool execution did not produce any input or output content to display.
          </Text>
        </View>
      )}
    </ToolViewCard>
  );
}
