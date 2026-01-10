import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, Trophy, Sparkles, Paperclip } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCompleteData } from './_utils';
import { FileAttachmentsGrid } from '@/components/chat/FileAttachmentRenderer';
import { TaskCompletedFeedback } from './TaskCompletedFeedback';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import { log } from '@/lib/logger';

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

export function CompleteToolView({ toolCall, toolResult, isStreaming = false, project, assistantMessage, currentIndex, totalCalls, onPromptFill, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { text, attachments, follow_up_prompts, success } = extractCompleteData({ toolCall, toolResult });
  const sandboxId = project?.sandbox?.id || assistantMessage?.sandbox_id;
  const sandboxUrl = project?.sandbox?.sandbox_url;

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

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
          rightContent: <StatusBadge variant="streaming" label="Completing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Completing Task"
            subtitle="Finalizing results..."
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
            label={actualIsSuccess ? 'Completed' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {attachments.length > 0 && (
            <Text className="text-xs text-muted-foreground">
              {attachments.length} {attachments.length === 1 ? 'file' : 'files'}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
        <View className="px-4 py-4 gap-6">
          {!text && attachments.length === 0 && success && (
            <View className="py-8 items-center">
              <View className="relative">
                <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 80, height: 80 }}>
                  <Icon as={Trophy} size={40} className="text-primary" />
                </View>
                <View className="absolute -top-1 -right-1">
                  <Icon as={Sparkles} size={20} className="text-primary" />
                </View>
              </View>
              <Text className="text-lg font-roobert-semibold text-foreground mt-4 mb-1">
                Task Completed Successfully
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                All objectives achieved
              </Text>
            </View>
          )}

          {text && (
            <View className="bg-muted/50 rounded-xl p-4 border border-border">
              <Text className="text-sm font-roobert text-foreground" selectable>
                {text}
              </Text>
            </View>
          )}

          {attachments.length > 0 && (
            <View className="gap-3">
              <View className="flex-row items-center gap-2">
                <Icon as={Paperclip} size={16} className="text-foreground/50" />
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  Files ({attachments.length})
                </Text>
              </View>
              <FileAttachmentsGrid
                filePaths={attachments}
                sandboxId={sandboxId}
                sandboxUrl={sandboxUrl}
                compact={false}
                showPreviews={true}
              />
            </View>
          )}

          {/* Task Completed Feedback */}
          {success && (
            <TaskCompletedFeedback
              taskSummary={text || undefined}
              followUpPrompts={follow_up_prompts.length > 0 ? follow_up_prompts : undefined}
              threadId={assistantMessage?.thread_id}
              messageId={assistantMessage?.message_id}
              onFollowUpClick={(prompt) => {
                log.log('📝 Follow-up clicked:', prompt);
                onPromptFill?.(prompt);
              }}
            />
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
