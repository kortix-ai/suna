import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircleQuestion, CheckCircle2, AlertCircle, Paperclip, Info, ChevronRight } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAskData } from './_utils';
import { FileAttachmentsGrid } from '@/components/chat/FileAttachmentRenderer';

export function AskToolView({ toolData, isStreaming = false, project, assistantMessage, currentIndex, totalCalls }: ToolViewProps) {
  const { text, attachments, follow_up_answers, success } = extractAskData(toolData);
  const sandboxId = project?.sandbox_id || assistantMessage?.sandbox_id;

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
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={MessageCircleQuestion} size={24} className="text-blue-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Ask User
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              Question Asked
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
            success ? 'bg-primary/10' : 'bg-destructive/10'
          }`}>
            <Icon 
              as={success ? CheckCircle2 : AlertCircle} 
              size={12} 
              className={success ? 'text-primary' : 'text-destructive'} 
            />
            <Text className={`text-xs font-roobert-medium ${
              success ? 'text-primary' : 'text-destructive'
            }`}>
              {success ? 'Success' : 'Failed'}
            </Text>
          </View>
        </View>

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

        {/* Follow-up Answers */}
        {follow_up_answers && follow_up_answers.length > 0 && (
          <View className="gap-2">
            {follow_up_answers.slice(0, 4).map((answer, index) => (
              <Pressable
                key={index}
                onPress={() => {
                  // TODO: Handle follow-up answer click - could trigger a response
                  console.log('Follow-up answer clicked:', answer);
                }}
                className="flex-row items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-muted/30 border border-border/50 active:bg-muted/50"
              >
                <Text className="text-sm font-roobert text-foreground/70 flex-1 leading-relaxed">
                  {answer}
                </Text>
                <Icon as={ChevronRight} size={14} className="text-muted-foreground/40" />
              </Pressable>
            ))}
          </View>
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

