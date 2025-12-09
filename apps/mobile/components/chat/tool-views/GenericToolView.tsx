/**
 * Generic Tool View
 *
 * Default fallback view for tools without specialized renderers
 */

import React, { useState, useMemo, useCallback } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
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
        }}>
        <View className="p-4">
          <Text className="text-sm text-primary opacity-50">
            This tool view requires structured metadata. Please update the component to use toolCall
            and toolResult props.
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
              <StatusBadge variant={actualIsSuccess ? 'success' : 'error'} iconOnly={true} />
            )}
            {isStreaming && <StatusBadge variant="streaming" iconOnly={true} />}
          </View>
        ),
      }}
      footer={
        <View className="w-full flex-row items-center justify-between">
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            {!isStreaming && (hasInput || hasOutput) && (
              <View className="flex-row items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
                <Icon as={Wrench} size={12} className="text-primary" />
                <Text className="font-roobert-medium text-xs text-primary">Tool</Text>
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
      }>
      {isStreaming ? (
        <View className="w-full flex-1">
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
          className="w-full flex-1"
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}>
          <View className="gap-4 p-4">
            {hasInput && (
              <View className="gap-2">
                <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">
                  Input
                </Text>
                <View className="rounded-xl border border-border bg-card p-4">
                  <Text className="font-roobert-mono text-xs leading-5 text-primary" selectable>
                    {formatContent(toolCall.arguments)}
                  </Text>
                </View>
              </View>
            )}

            {hasOutput && (
              <View className="gap-2">
                <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">
                  Output
                </Text>
                <View className="rounded-xl border border-border bg-card p-4">
                  <Text className="font-roobert-mono text-xs leading-5 text-primary" selectable>
                    {formatContent(toolResult?.output)}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center px-6 py-12">
          <View
            className="mb-6 items-center justify-center rounded-full bg-card"
            style={{ width: 80, height: 80 }}>
            <Icon as={Wrench} size={40} className="text-primary opacity-50" />
          </View>
          <Text className="mb-2 font-roobert-semibold text-xl text-primary">
            No Content Available
          </Text>
          <Text className="max-w-md text-center text-sm text-primary opacity-50">
            This tool execution did not produce any input or output content to display.
          </Text>
        </View>
      )}
    </ToolViewCard>
  );
}
