import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Palette, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDesignerData } from './_utils';
import { FileAttachmentRenderer } from '@/components/chat/FileAttachmentRenderer';

export function DesignerToolView({ toolCall, toolResult, isStreaming = false, assistantMessage, project }: ToolViewProps) {
  const extractedData = extractDesignerData({ toolCall, toolResult });
  const { mode, prompt, generatedImagePath, designUrl, width, height, error, success, sandboxId: extractedSandboxId } = extractedData;

  const sandboxId = extractedSandboxId || project?.sandbox_id || assistantMessage?.sandbox_id;

  console.log('🎨 [DesignerToolView] Data:', {
    generatedImagePath,
    sandboxId,
    extractedSandboxId,
    designUrl,
    args: toolCall.arguments,
    output: toolResult?.output
  });

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-background border-border border rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Palette} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {mode === 'create' ? 'Creating Design' : 'Editing Design'}
        </Text>
        {prompt && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={3}>
              {prompt}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (error) {
    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-6 gap-6">
          <View className="bg-red-500/10 rounded-xl p-4 border border-red-500/20">
            <Text className="text-sm font-roobert text-red-600 dark:text-red-400">
              {error}
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 gap-6">
        {prompt && (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Prompt
            </Text>
            <View className="bg-card border border-border rounded-2xl p-4">
              <Text className="text-sm font-roobert text-foreground/90" selectable>
                {prompt}
              </Text>
            </View>
          </View>
        )}

        {(width || height) && (
          <View className="flex-row gap-2">
            {width && (
              <View className="bg-card border border-border rounded-2xl p-3 flex-1">
                <Text className="text-xs font-roobert-medium text-foreground/50 mb-1">Width</Text>
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {width}px
                </Text>
              </View>
            )}
            {height && (
              <View className="bg-card border border-border rounded-2xl p-3 flex-1">
                <Text className="text-xs font-roobert-medium text-foreground/50 mb-1">Height</Text>
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {height}px
                </Text>
              </View>
            )}
          </View>
        )}

        {generatedImagePath && sandboxId ? (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Generated Design
            </Text>
            <FileAttachmentRenderer
              filePath={generatedImagePath}
              sandboxId={sandboxId}
              showName={false}
              showPreview={true}
            />
          </View>
        ) : (
          <View className="py-8 items-center">
            <View className="bg-background border-border border rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
              <Icon as={Palette} size={40} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              No Design Generated
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              The design could not be loaded
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

