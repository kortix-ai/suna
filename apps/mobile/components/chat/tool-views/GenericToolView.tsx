/**
 * Generic Tool View
 *
 * Default fallback view for tools without specialized renderers
 */

import React, { useState, useMemo, useCallback } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Clock,
  Wrench,
  Copy,
  Check,
} from 'lucide-react-native';
import type { ToolViewProps } from './types';
import { ToolViewCard, StatusBadge, LoadingState, JsonViewer } from './shared';
import { getToolMetadata } from './tool-metadata';
import { useColorScheme } from 'nativewind';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

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
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isCopyingInput, setIsCopyingInput] = useState(false);
  const [isCopyingOutput, setIsCopyingOutput] = useState(false);

  // Defensive check - handle cases where toolCall might be undefined or missing function_name
  if (!toolCall || !toolCall.function_name) {
    return (
      <ToolViewCard
        header={{
          icon: Wrench,
          iconColor: 'text-muted-foreground',
          iconBgColor: 'bg-muted/10',
          subtitle: '',
          title: 'Tool View Error',
          isSuccess: false,
          isStreaming: false,
        }}
      >
        <View className="p-4">
          <Text className="text-sm text-muted-foreground">
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

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

  const handleCopyInput = useCallback(async () => {
    if (!toolCall?.arguments) return;
    setIsCopyingInput(true);
    await copyToClipboard(JSON.stringify(toolCall.arguments, null, 2));
    setTimeout(() => setIsCopyingInput(false), 2000);
  }, [toolCall?.arguments, copyToClipboard]);

  const handleCopyOutput = useCallback(async () => {
    if (!toolResult?.output) return;
    setIsCopyingOutput(true);
    const outputText = typeof toolResult.output === 'string'
      ? toolResult.output
      : JSON.stringify(toolResult.output, null, 2);
    await copyToClipboard(outputText);
    setTimeout(() => setIsCopyingOutput(false), 2000);
  }, [toolResult?.output, copyToClipboard]);

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
              <View
                className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                }}
              >
                <Icon as={Wrench} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground">
                  Tool
                </Text>
              </View>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            <Icon as={Clock} size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
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
            bgColor="bg-primary/10"
            title="Executing tool"
            filePath={name}
            showProgress={true}
          />
        </View>
      ) : hasInput || hasOutput ? (
        <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
          <View className="p-4 gap-4">
            {hasInput && (
              <View className="gap-2">
                <View className="flex-row items-center justify-between mb-2">
                  <View
                    className="px-1.5 py-0.5 rounded border"
                    style={{
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                    }}
                  >
                    <Text className="text-xs font-roobert-medium text-foreground">
                      Input
                    </Text>
                  </View>
                  <Pressable
                    onPress={handleCopyInput}
                    disabled={isCopyingInput}
                    className="h-6 w-6 items-center justify-center rounded active:opacity-70"
                    style={{
                      backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                    }}
                  >
                    <Icon
                      as={isCopyingInput ? Check : Copy}
                      size={12}
                      className={isCopyingInput ? 'text-primary' : 'text-foreground'}
                    />
                  </Pressable>
                </View>
                <View
                  className="bg-card border border-border rounded-xl p-3.5"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  }}
                >
                  <JsonViewer data={toolCall.arguments} title="" defaultExpanded={true} />
                </View>
              </View>
            )}

            {hasOutput && (
              <View className="gap-2">
                <View className="flex-row items-center justify-between mb-2">
                  <View
                    className="px-1.5 py-0.5 rounded border"
                    style={{
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                    }}
                  >
                    <Text className="text-xs font-roobert-medium text-foreground">
                      Output
                    </Text>
                  </View>
                  <Pressable
                    onPress={handleCopyOutput}
                    disabled={isCopyingOutput}
                    className="h-6 w-6 items-center justify-center rounded active:opacity-70"
                    style={{
                      backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                    }}
                  >
                    <Icon
                      as={isCopyingOutput ? Check : Copy}
                      size={12}
                      className={isCopyingOutput ? 'text-primary' : 'text-foreground'}
                    />
                  </Pressable>
                </View>
                <View
                  className="bg-card border border-border rounded-xl p-3.5"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  }}
                >
                  <JsonViewer data={toolResult?.output} title="" defaultExpanded={true} />
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center py-12 px-6">
          <View
            className="rounded-full items-center justify-center mb-6"
            style={{
              width: 80,
              height: 80,
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
            }}
          >
            <Icon as={Wrench} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            No Content Available
          </Text>
          <Text className="text-sm text-muted-foreground text-center max-w-md">
            This tool execution did not produce any input or output content to display.
          </Text>
        </View>
      )}
    </ToolViewCard>
  );
}
