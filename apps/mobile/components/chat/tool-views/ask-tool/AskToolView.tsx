import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircleQuestion, Paperclip, Info } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAskData } from './_utils';
import { FileAttachmentsGrid } from '@/components/chat/FileAttachmentRenderer';
import { PromptExamples } from '@/components/shared';
import { useLanguage } from '@/contexts/LanguageContext';

export function AskToolView({ toolCall, toolResult, isSuccess = true, isStreaming = false, project, onPromptFill }: ToolViewProps) {
  const { text, attachments, follow_up_answers, success } = extractAskData(toolCall, toolResult, isSuccess);
  const sandboxId = project?.sandbox_id;
  const { t } = useLanguage();

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={MessageCircleQuestion} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Asking User
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Waiting for user response...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 gap-6">
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

        <View className="flex-row items-start gap-2.5 rounded-xl border border-border bg-muted/40 dark:bg-muted/20 px-3 py-2.5">
          <Icon as={Info} size={16} className="text-muted-foreground mt-0.5 flex-shrink-0" />
          <Text className="text-sm font-roobert text-muted-foreground flex-1 leading-relaxed">
            Kortix will automatically continue working once you provide your response.
          </Text>
        </View>

        {/* Follow-up Answers - Suggested responses using shared PromptExamples */}
        {follow_up_answers && follow_up_answers.length > 0 && (
          <PromptExamples
            prompts={follow_up_answers}
            onPromptClick={onPromptFill}
            title={t('chat.suggestedResponses', { defaultValue: 'Suggested responses' })}
            showTitle={true}
            maxPrompts={4}
          />
        )}

        {!text && attachments.length === 0 && (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={MessageCircleQuestion} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              Question Asked
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              No additional details provided
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}
