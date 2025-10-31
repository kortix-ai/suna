import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, Trophy, Sparkles, Paperclip } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCompleteData } from './_utils';
import { FileAttachmentsGrid } from '@/components/chat/FileAttachmentRenderer';

export function CompleteToolView({ toolData, isStreaming = false, project, assistantMessage }: ToolViewProps) {
  const { text, attachments, success } = extractCompleteData(toolData);
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
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-emerald-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={CheckCircle2} size={24} className="text-emerald-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Task Complete
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              Completed
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
            success ? 'bg-emerald-500/10' : 'bg-destructive/10'
          }`}>
            <Icon 
              as={success ? CheckCircle2 : AlertCircle} 
              size={12} 
              className={success ? 'text-emerald-500' : 'text-destructive'} 
            />
            <Text className={`text-xs font-roobert-medium ${
              success ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
            }`}>
              {success ? 'Success' : 'Failed'}
            </Text>
          </View>
        </View>

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
      </View>
    </ScrollView>
  );
}

