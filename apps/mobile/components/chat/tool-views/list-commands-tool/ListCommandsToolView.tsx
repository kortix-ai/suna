import React, { useMemo } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Terminal,
  TerminalIcon,
  Clock,
  CircleDashed,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
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

function getToolTitle(toolName: string): string {
  const normalizedName = toolName.toLowerCase();
  const toolTitles: Record<string, string> = {
    'list-commands': 'Running Commands',
    'list_commands': 'Running Commands',
  };
  return toolTitles[normalizedName] || 'Running Commands';
}

interface CommandSession {
  session_name?: string;
  sessionName?: string;
  command?: string;
  status?: string;
  pid?: number;
  cwd?: string;
  [key: string]: any;
}

export function ListCommandsToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);
  const toolMetadata = getToolMetadata(name, toolCall.arguments);

  // Extract commands/sessions from output
  const commands = useMemo(() => {
    if (!toolResult?.output) return [];

    let output = toolResult.output;

    // Handle string output - try to parse as JSON
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {
        // If parsing fails, try to extract array from string
        const arrayMatch = output.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            output = JSON.parse(arrayMatch[0]);
          } catch {
            return [];
          }
        } else {
          return [];
        }
      }
    }

    // Handle array output
    if (Array.isArray(output)) {
      return output;
    }

    // Handle object with commands/sessions array
    if (typeof output === 'object' && output !== null) {
      if (Array.isArray(output.commands)) {
        return output.commands;
      }
      if (Array.isArray(output.sessions)) {
        return output.sessions;
      }
      if (Array.isArray(output.results)) {
        return output.results;
      }
      // If it's a single object, wrap it in an array
      return [output];
    }

    return [];
  }, [toolResult?.output]);

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

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
        <View className="flex-1 w-full">
          <LoadingState
            icon={Terminal}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title="Listing commands"
            filePath="Retrieving running commands..."
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
        subtitle: '',
        title: toolTitle,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        rightContent: !isStreaming && (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            iconOnly={true}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <View className="flex-row items-center gap-2 flex-1 min-w-0">
            {!isStreaming && commands.length > 0 && (
              <View
                className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                }}
              >
                <Icon as={Terminal} size={12} className="text-foreground" />
                <Text className="text-xs font-roobert-medium text-foreground">
                  {commands.length} {commands.length === 1 ? 'Command' : 'Commands'}
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
      {commands.length > 0 ? (
        <View className="flex-1 w-full">
          <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
            <View className="p-4 gap-3">
              {commands.map((cmd: CommandSession, index: number) => {
                const sessionName = cmd.session_name || cmd.sessionName || `Session ${index + 1}`;
                const command = cmd.command || cmd.cmd || null;
                const status = cmd.status || cmd.state || null;
                const cwd = cmd.cwd || cmd.working_directory || null;

                return (
                  <View
                    key={index}
                    className="bg-card border border-border rounded-xl p-3.5"
                    style={{
                      backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                    }}
                  >
                    {/* Session name */}
                    <View className="flex-row items-center gap-2 mb-2">
                      <View
                        className="px-1.5 py-0.5 rounded border"
                        style={{
                          borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                        }}
                      >
                        <View className="flex-row items-center gap-1">
                          <Icon as={TerminalIcon} size={10} className="text-muted-foreground" />
                          <Text className="text-xs font-roobert-medium text-foreground">
                            Session
                          </Text>
                        </View>
                      </View>
                      {status && (
                        <View
                          className="px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: status.toLowerCase().includes('running')
                              ? (isDark ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.1)')
                              : (isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)'),
                          }}
                        >
                          <Text
                            className="text-xs font-roobert-medium"
                            style={{
                              color: status.toLowerCase().includes('running') ? '#10b981' : undefined,
                            }}
                          >
                            {status}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text className="text-xs font-roobert-mono text-foreground mb-2" selectable>
                      {sessionName}
                    </Text>

                    {/* Command if available */}
                    {command && (
                      <View className="mt-2 pt-2 border-t border-border">
                        <View className="flex-row items-center gap-2 mb-1">
                          <View
                            className="px-1.5 py-0.5 rounded border"
                            style={{
                              borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
                            }}
                          >
                            <View className="flex-row items-center gap-1">
                              <Icon as={TerminalIcon} size={10} className="text-muted-foreground" />
                              <Text className="text-xs font-roobert-medium text-foreground">
                                Command
                              </Text>
                            </View>
                          </View>
                        </View>
                        <View className="flex-row items-center">
                          <Text className="text-xs font-roobert-mono text-primary font-semibold">
                            ${' '}
                          </Text>
                          <Text className="text-xs font-roobert-mono text-foreground flex-1" selectable>
                            {command}
                          </Text>
                        </View>
                      </View>
                    )}

                    {/* CWD if available */}
                    {cwd && (
                      <View className="mt-2 pt-2 border-t border-border">
                        <Text className="text-xs font-roobert-mono text-muted-foreground" selectable>
                          {cwd}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </ScrollView>
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
            <Icon as={CircleDashed} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            No Running Commands
          </Text>
          <Text className="text-sm text-muted-foreground text-center max-w-md">
            There are currently no running commands or sessions.
          </Text>
        </View>
      )}
    </ToolViewCard>
  );
}








