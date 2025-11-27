import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, Trophy, Sparkles, Paperclip } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCompleteData } from './_utils';
import { FileAttachmentsGrid } from '@/components/chat/FileAttachmentRenderer';
import { TaskCompletedFeedback } from './TaskCompletedFeedback';

export function CompleteToolView({ toolCall, toolResult, isStreaming = false, project, assistantMessage, currentIndex, totalCalls }: ToolViewProps) {
  const { text, attachments, follow_up_prompts, success } = extractCompleteData({ toolCall, toolResult });
  const sandboxId = project?.sandbox_id || assistantMessage?.sandbox_id;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-emerald-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={CheckCircle2} size={40} className="text-emerald-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Completing Task
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Finalizing results...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 gap-6">
        {!text && attachments.length === 0 && success && (
          <View className="py-8 items-center">
            <View className="relative">
              <View className="bg-emerald-500/10 rounded-2xl items-center justify-center" style={{ width: 80, height: 80 }}>
                <Icon as={Trophy} size={40} className="text-emerald-500" />
              </View>
              <View className="absolute -top-1 -right-1">
                <Icon as={Sparkles} size={20} className="text-yellow-500" />
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
              // TODO: Handle follow-up click - could trigger a new message
              console.log('Follow-up clicked:', prompt);
            }}
          />
        )}
      </View>
    </ScrollView>
  );
}

