import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Terminal,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Clock,
  TerminalIcon,
  StopCircle,
  Power,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractTerminateCommandData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import { useColorScheme } from 'nativewind';
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

export function TerminateCommandToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [progress, setProgress] = useState(0);
  const [showFullOutput, setShowFullOutput] = useState(true);

  if (!toolCall) {
    return null;
  }

  const {
    sessionName,
    output,
    success: actualIsSuccess,
  } = extractTerminateCommandData(toolCall, toolResult, isSuccess);

  // Extract session_name from toolCall.arguments (from metadata)
  const finalSessionName = sessionName || toolCall.arguments?.session_name || null;

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  
  // Get tool title - match frontend getToolTitle function
  const getToolTitle = (toolName: string): string => {
    const normalizedName = toolName.toLowerCase();
    const toolTitles: Record<string, string> = {
      'execute-command': 'Execute Command',
      'check-command-output': 'Check Command Output',
      'terminate-command': 'Terminate Session',
    };
    return toolTitles[normalizedName] || 'Terminate Session';
  };

  const toolTitle = getToolTitle(name) || 'Terminate Session';
  const toolMetadata = getToolMetadata(name, toolCall.arguments);

  const terminationSuccess = useMemo(() => {
    if (!output) return actualIsSuccess;

    const outputLower = String(output).toLowerCase();
    if (outputLower.includes('does not exist')) return false;
    if (outputLower.includes('terminated') || outputLower.includes('killed')) return true;

    return actualIsSuccess;
  }, [output, actualIsSuccess]);

  useEffect(() => {
    if (isStreaming) {
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + 5;
        });
      }, 300);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isStreaming]);

  const formattedOutput = useMemo(() => {
    if (!output) return [];
    let processedOutput = output;
    try {
      if (typeof output === 'string' && (output.trim().startsWith('{') || output.trim().startsWith('['))) {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && parsed.output) {
          processedOutput = parsed.output;
        }
      }
    } catch (e) {
      // Ignore parse errors
    }

    processedOutput = String(processedOutput);
    processedOutput = processedOutput.replace(/\\\\/g, '\\');

    processedOutput = processedOutput
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");

    processedOutput = processedOutput.replace(/\\u([0-9a-fA-F]{4})/g, (_match, group) => {
      return String.fromCharCode(parseInt(group, 16));
    });
    return processedOutput.split('\n');
  }, [output]);

  const hasMoreLines = formattedOutput.length > 10;
  const previewLines = formattedOutput.slice(0, 10);
  const linesToShow = showFullOutput ? formattedOutput : previewLines;

  // Add empty lines for natural scrolling
  const emptyLines = Array.from({ length: 30 }, () => '');

  // Show loading state during streaming
  if (isStreaming) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: '',
          title: toolTitle,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" iconOnly={true} />,
        }}
      >
        <View className="flex-1 items-center justify-center py-12 px-6">
          <View className="text-center w-full max-w-xs">
            <View
              className="rounded-full mx-auto mb-6 items-center justify-center"
              style={{
                width: 64,
                height: 64,
                backgroundColor: isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
              }}
            >
              <Icon as={StopCircle} size={32} className="text-destructive" />
            </View>
            <Text className="text-lg font-roobert-medium mb-2 text-foreground">
              Terminating session
            </Text>
            <Text className="text-sm text-muted-foreground mb-6">
              <Text className="text-xs font-roobert-mono break-all">
                {finalSessionName || 'Processing termination...'}
              </Text>
            </Text>
            <View
              className="w-full h-1 rounded-full mb-2"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
              }}
            >
              <View
                className="h-full rounded-full"
                style={{
                  width: `${progress}%`,
                  backgroundColor: '#ef4444',
                }}
              />
            </View>
            <Text className="text-xs text-muted-foreground mt-2">{progress}%</Text>
          </View>
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
        subtitle: '',
        title: toolTitle,
        isSuccess: terminationSuccess,
        isStreaming: false,
        rightContent: !isStreaming && (
          <StatusBadge
            variant={terminationSuccess ? 'success' : 'error'}
            iconOnly={true}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2 flex-1 min-w-0">
            {!isStreaming && finalSessionName && (
              <View
                className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                }}
              >
                <Icon as={StopCircle} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground">
                  Terminate
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
      {finalSessionName ? (
        <View className="flex-1 w-full">
          <View className="flex-shrink-0 p-4 pb-2">
            {/* Session info */}
            <View
              className="mb-4 bg-card border border-border rounded-xl p-3.5"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
              }}
            >
              <View className="flex-row items-center gap-2 mb-2">
                <View
                  className="px-1.5 py-0.5 rounded border"
                  style={{
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                  }}
                >
                  <View className="flex-row items-center gap-1">
                    <Icon as={Power} size={10} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert-medium text-foreground">
                      Session
                    </Text>
                  </View>
                </View>
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-destructive text-xs" selectable>●</Text>
                <Text className="text-xs font-roobert-mono text-foreground flex-1 break-all" selectable>
                  {finalSessionName}
                </Text>
              </View>
            </View>

            {/* Result badge */}
            {output && (
              <View
                className="mb-4 bg-card border border-border rounded-xl p-3.5"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                }}
              >
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-2">
                    <View
                      className="px-1.5 py-0.5 rounded border"
                      style={{
                        borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                      }}
                    >
                      <View className="flex-row items-center gap-1">
                        <Icon as={TerminalIcon} size={10} className="text-muted-foreground" />
                        <Text className="text-xs font-roobert-medium text-foreground">
                          Result
                        </Text>
                      </View>
                    </View>
                  </View>
                  <View
                    className="px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: terminationSuccess
                        ? (isDark ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.1)')
                        : (isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)'),
                    }}
                  >
                    <Text
                      className="text-xs font-roobert-medium"
                      style={{
                        color: terminationSuccess ? '#10b981' : '#ef4444',
                      }}
                    >
                      {terminationSuccess ? 'Success' : 'Failed'}
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </View>

          {/* Output section - fills remaining height and scrolls */}
          {output ? (
            <View className="flex-1 min-h-0 px-4 pb-4">
              <View
                className="flex-1 bg-card border border-border rounded-xl flex-col overflow-hidden"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                }}
              >
                <View className="flex-shrink-0 p-3.5 pb-2 border-b border-border">
                  <View className="flex-row items-center gap-2">
                    <View
                      className="px-1.5 py-0.5 rounded border"
                      style={{
                        borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                      }}
                    >
                      <View className="flex-row items-center gap-1">
                        <Icon as={TerminalIcon} size={10} className="text-muted-foreground" />
                        <Text className="text-xs font-roobert-medium text-foreground">
                          Output
                        </Text>
                      </View>
                    </View>
                    {!terminationSuccess && (
                      <View
                        className="px-1.5 py-0.5 rounded border"
                        style={{
                          borderColor: '#ef4444',
                          backgroundColor: isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
                        }}
                      >
                        <View className="flex-row items-center gap-1">
                          <Icon as={AlertTriangle} size={10} className="text-destructive" />
                          <Text className="text-xs font-roobert-medium text-destructive">
                            Error
                          </Text>
                        </View>
                      </View>
                    )}
                  </View>
                </View>
                <ScrollView
                  className="flex-1 min-h-0"
                  showsVerticalScrollIndicator={true}
                >
                  <View className="p-3.5 pt-2">
                    {linesToShow.map((line, index) => (
                      <Text
                        key={index}
                        className="text-xs font-roobert-mono text-foreground leading-5"
                        selectable
                      >
                        {line || ' '}
                        {'\n'}
                      </Text>
                    ))}
                    {/* Add empty lines for natural scrolling */}
                    {showFullOutput && emptyLines.map((_, idx) => (
                      <Text key={`empty-${idx}`} className="text-xs font-roobert-mono">
                        {'\n'}
                      </Text>
                    ))}
                    {!showFullOutput && hasMoreLines && (
                      <Pressable
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setShowFullOutput(true);
                        }}
                        className="mt-2 pt-2 border-t border-border"
                      >
                        <Text className="text-xs font-roobert-mono text-muted-foreground">
                          + {formattedOutput.length - 10} more lines (tap to expand)
                        </Text>
                      </Pressable>
                    )}
                  </View>
                </ScrollView>
              </View>
            </View>
          ) : !isStreaming ? (
            <View className="flex-1 flex items-center justify-center px-4 pb-4">
              <View
                className="bg-card border border-border rounded-xl p-4"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                }}
              >
                <View className="items-center">
                  <Icon as={CircleDashed} size={32} className="text-muted-foreground mb-2" />
                  <Text className="text-sm text-muted-foreground">No output received</Text>
                </View>
              </View>
            </View>
          ) : null}
        </View>
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
            <Icon as={StopCircle} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            No Session Found
          </Text>
          <Text className="text-sm text-muted-foreground text-center max-w-md">
            No session name was detected. Please provide a valid session to terminate.
          </Text>
        </View>
      )}
    </ToolViewCard>
  );
}
