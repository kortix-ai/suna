import React, { useState, useMemo } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Terminal,
  AlertCircle,
  Copy,
  Check,
  Clock,
  Loader2,
} from 'lucide-react-native';
import type { ToolViewProps } from './types';
import { extractCommandData } from './command-tool/_utils';
import { ToolViewCard, StatusBadge, LoadingState } from './shared';
import { getToolMetadata } from './tool-metadata';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';

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

export function CommandToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [showFullOutput, setShowFullOutput] = useState(true);
  const [copied, setCopied] = useState(false);

  const {
    command,
    output,
    exitCode,
    sessionName,
    cwd,
    completed,
    success: actualIsSuccess,
    timestamp: actualToolTimestamp,
  } = extractCommandData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const actualAssistantTimestamp = assistantTimestamp;
  const name = toolCall?.function_name.replace(/_/g, '-') || 'execute-command';

  const displayText = name === 'check-command-output' ? sessionName : command;
  const displayLabel = name === 'check-command-output' ? 'Session' : 'Command';
  const displayPrefix = name === 'check-command-output' ? 'tmux:' : '$';

  const toolMetadata = getToolMetadata(name, toolCall?.arguments);

  // Check if this is a non-blocking command with just a status message
  const isNonBlockingCommand = useMemo(() => {
    if (!output) return false;

    const nonBlockingPatterns = [
      'Command sent to tmux session',
      'Use check_command_output to view results',
      'Session still running',
      'completed: false'
    ];

    return nonBlockingPatterns.some(pattern =>
      String(output).toLowerCase().includes(pattern.toLowerCase())
    );
  }, [output]);

  // Check if there's actual command output to display
  const hasActualOutput = useMemo(() => {
    if (!output) return false;
    if (isNonBlockingCommand) return false;

    const actualOutputPatterns = [
      'root@',
      'COMMAND_DONE_',
      'Count:',
      'date:',
      'ls:',
      'pwd:'
    ];

    return actualOutputPatterns.some(pattern =>
      String(output).includes(pattern)
    ) || String(output).trim().length > 50;
  }, [output, isNonBlockingCommand]);

  const formattedOutput = useMemo(() => {
    if (!output || !hasActualOutput) return [];

    let processedOutput = String(output);

    // Handle case where output is already an object
    if (typeof output === 'object' && output !== null) {
      try {
        processedOutput = JSON.stringify(output, null, 2);
      } catch (e) {
        processedOutput = String(output);
      }
    } else if (typeof output === 'string') {
      try {
        if (processedOutput.trim().startsWith('{') || processedOutput.trim().startsWith('[')) {
          const parsed = JSON.parse(processedOutput);
          if (parsed && typeof parsed === 'object') {
            processedOutput = JSON.stringify(parsed, null, 2);
          } else {
            processedOutput = String(parsed);
          }
        }
      } catch (e) {
        // Use as plain text
      }
    }

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
  }, [output, hasActualOutput]);

  const hasMoreLines = formattedOutput.length > 10;
  const previewLines = formattedOutput.slice(0, 10);
  const linesToShow = showFullOutput ? formattedOutput : previewLines;

  const handleCopy = async () => {
    if (!output) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(String(output));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Show loading state during streaming
  if (isStreaming && !command) {
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
          rightContent: <StatusBadge variant="streaming" label="Executing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title={name === 'check-command-output' ? 'Checking command output' : 'Executing command'}
            filePath={displayText || 'Processing command...'}
            showProgress={true}
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
        isStreaming: isStreaming,
        rightContent: !isStreaming && (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={
              actualIsSuccess
                ? (name === 'check-command-output' ? 'Retrieved' : 'Success')
                : (name === 'check-command-output' ? 'Failed' : 'Failed')
            }
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2">
            {!isStreaming && displayText && (
              <View
                className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                }}
              >
                <Icon as={Terminal} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground">
                  {displayLabel}
                </Text>
              </View>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            <Icon as={Clock} size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              {actualToolTimestamp && !isStreaming
                ? formatTimestamp(actualToolTimestamp)
                : actualAssistantTimestamp
                  ? formatTimestamp(actualAssistantTimestamp)
                  : ''}
            </Text>
          </View>
        </View>
      }
    >
      {isStreaming ? (
        <View className="flex-1 w-full">
          {command && (
            <View className="p-4 pb-2">
              <View className="bg-card border border-border rounded-xl p-3.5 mb-4">
                <View className="flex-row items-center gap-2 mb-2">
                  <View
                    className="px-1.5 py-0.5 rounded border"
                    style={{
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                    }}
                  >
                    <Text className="text-xs font-roobert-medium text-foreground">
                      Command
                    </Text>
                  </View>
                  <StatusBadge variant="streaming" label="Streaming" />
                </View>
                <View className="flex-row items-center">
                  <Text className="text-sm font-roobert-mono text-primary font-semibold">
                    {displayPrefix}{' '}
                  </Text>
                  <Text className="text-sm font-roobert-mono text-foreground flex-1">
                    {command}
                  </Text>
                </View>
              </View>
            </View>
          )}
          {!command && (
            <LoadingState
              icon={Terminal}
              iconColor="text-primary"
              bgColor="bg-primary/10"
              title={name === 'check-command-output' ? 'Checking command output' : 'Executing command'}
              filePath={displayText || 'Processing command...'}
              showProgress={true}
            />
          )}
        </View>
      ) : displayText ? (
        <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
          <View className="p-4 gap-4">
            {/* Command section */}
            {command && (
              <View className="bg-card border border-border rounded-xl p-3.5">
                <View className="flex-row items-center gap-2 mb-2">
                  <View
                    className="px-1.5 py-0.5 rounded border"
                    style={{
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                    }}
                  >
                    <Text className="text-xs font-roobert-medium text-foreground">
                      Command
                    </Text>
                  </View>
                </View>
                <View className="flex-row items-center">
                  <Text className="text-sm font-roobert-mono text-primary font-semibold">
                    {displayPrefix}{' '}
                  </Text>
                  <Text className="text-sm font-roobert-mono text-foreground flex-1" selectable>
                    {command}
                  </Text>
                </View>
              </View>
            )}

            {/* Show status message for non-blocking commands */}
            {isNonBlockingCommand && output && (
              <View className="bg-muted/50 border border-border rounded-xl p-3.5">
                <View className="flex-row items-center gap-2 mb-2">
                  <Icon as={AlertCircle} size={16} className="text-primary" />
                  <Text className="text-sm font-roobert-medium text-foreground">
                    Command Status
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">{String(output)}</Text>
              </View>
            )}

            {/* Output section */}
            {formattedOutput.length > 0 ? (
              <View className="bg-card border border-border rounded-xl overflow-hidden">
                <View className="flex-row items-center justify-between p-3.5 pb-2 border-b border-border">
                  <View className="flex-row items-center gap-2">
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
                    {exitCode !== null && exitCode !== 0 && (
                      <View
                        className="px-1.5 py-0.5 rounded border"
                        style={{
                          borderColor: '#ef4444',
                          backgroundColor: isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
                        }}
                      >
                        <View className="flex-row items-center gap-1">
                          <Icon as={AlertCircle} size={10} className="text-destructive" />
                          <Text className="text-xs font-roobert-medium text-destructive">
                            Error
                          </Text>
                        </View>
                      </View>
                    )}
                  </View>
                  <Pressable
                    onPress={handleCopy}
                    className="flex-row items-center gap-1.5 px-2 py-1 rounded active:opacity-70"
                    style={{
                      backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                    }}
                  >
                    <Icon
                      as={copied ? Check : Copy}
                      size={14}
                      className={copied ? 'text-primary' : 'text-foreground'}
                    />
                  </Pressable>
                </View>
                <ScrollView
                  className="max-h-96"
                  showsVerticalScrollIndicator={true}
                >
                  <View className="p-3.5 pt-2">
                    {linesToShow.map((line, idx) => (
                      <Text
                        key={idx}
                        className="text-xs font-roobert-mono text-foreground/80 leading-5"
                        selectable
                      >
                        {line}
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
            ) : !isNonBlockingCommand ? (
              <View className="flex-1 items-center justify-center py-8">
                <View className="bg-card border border-border rounded-xl p-4">
                  <Icon as={AlertCircle} size={32} className="text-muted-foreground mb-2" />
                  <Text className="text-sm text-muted-foreground text-center">
                    No output received
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Terminal} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            {name === 'check-command-output' ? 'No Session Found' : 'No Command Found'}
          </Text>
          <Text className="text-sm text-muted-foreground text-center max-w-md">
            {name === 'check-command-output'
              ? 'No session name was detected. Please provide a valid session name to check.'
              : 'No command was detected. Please provide a valid command to execute.'}
          </Text>
        </View>
      )}
    </ToolViewCard>
  );
}
