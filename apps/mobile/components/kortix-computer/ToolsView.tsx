import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Computer, CircleDashed } from 'lucide-react-native';
import { getToolViewComponent } from '@/components/chat/tool-views';
import { getToolMetadata } from '@/components/chat/tool-views/tool-metadata';
import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';
import type { UnifiedMessage } from '@/api/types';

interface ToolsViewProps {
  toolCall: ToolCallData | null;
  toolResult?: ToolResultData;
  assistantMessage?: UnifiedMessage | null;
  toolMessage?: UnifiedMessage;
  assistantTimestamp?: string;
  toolTimestamp?: string;
  isSuccess?: boolean;
  isStreaming?: boolean;
  project?: {
    id: string;
    name: string;
    sandbox?: {
      id?: string;
      sandbox_url?: string;
      vnc_preview?: string;
      pass?: string;
    };
  };
  currentIndex?: number;
  totalCalls?: number;
  onFileClick?: (filePath: string) => void;
  onPromptFill?: (prompt: string) => void;
}

export function ToolsView({
  toolCall,
  toolResult,
  assistantMessage,
  toolMessage,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  currentIndex,
  totalCalls,
  onFileClick,
  onPromptFill,
}: ToolsViewProps) {
  const toolName = useMemo(() => {
    if (!toolCall || !toolCall.function_name) return null;
    return toolCall.function_name.replace(/_/g, '-');
  }, [toolCall]);

  const ToolViewComponent = useMemo(() => {
    if (!toolName) return null;
    return getToolViewComponent(toolName);
  }, [toolName]);

  const toolMetadata = useMemo(() => {
    if (!toolCall || !toolCall.function_name) return null;
    const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
      ? toolCall.arguments
      : typeof toolCall.arguments === 'string'
        ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
        : {};
    return getToolMetadata(toolCall.function_name, args);
  }, [toolCall]);

  if (!toolCall || !toolCall.function_name) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <View className="flex-col items-center space-y-4 max-w-sm">
          <View className="relative">
            <View className="w-16 h-16 bg-muted rounded-full items-center justify-center">
              <Icon
                as={Computer}
                size={32}
                className="text-primary opacity-50"
                strokeWidth={1.5}
              />
            </View>
          </View>
          <View className="space-y-2">
            <Text className="text-lg font-roobert-semibold text-center">
              No Actions Yet
            </Text>
            <Text className="text-sm text-muted-foreground text-center leading-relaxed">
              Worker actions will appear here when tools are executed
            </Text>
          </View>
        </View>
      </View>
    );
  }

  if (isStreaming && !toolResult) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <View className="flex-col items-center space-y-4 max-w-sm">
          <View className="relative">
            <View className="w-16 h-16 bg-blue-50 dark:bg-blue-900/20 rounded-full items-center justify-center">
              <Icon
                as={CircleDashed}
                size={32}
                className="text-primary"
                strokeWidth={1.5}
              />
            </View>
          </View>
          <View className="space-y-2">
            <Text className="text-lg font-roobert-semibold text-center">
              Tool is running
            </Text>
            <Text className="text-sm text-muted-foreground text-center leading-relaxed">
              {toolMetadata?.title || 'Tool'} is currently executing. Results will appear here when complete.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  if (!ToolViewComponent) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <Text className="text-sm text-muted-foreground">
          Unknown tool type: {toolName}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ToolViewComponent
        toolCall={toolCall}
        toolResult={toolResult || undefined}
        assistantMessage={assistantMessage}
        toolMessage={toolMessage}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
        currentIndex={currentIndex}
        totalCalls={totalCalls}
        project={project}
        threadId={toolMessage?.thread_id || assistantMessage?.thread_id}
        onFileClick={onFileClick}
        onPromptFill={onPromptFill}
      />
    </View>
  );
}

