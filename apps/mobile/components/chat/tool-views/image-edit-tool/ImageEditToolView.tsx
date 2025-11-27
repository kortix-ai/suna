import React, { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Wand2, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractImageEditData } from './_utils';
import { FileAttachmentRenderer } from '@/components/chat/FileAttachmentRenderer';
import { useThread } from '@/lib/chat/hooks';

export function ImageEditToolView({ toolCall, toolResult, isStreaming = false, assistantMessage, toolMessage, project }: ToolViewProps) {
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Get thread data to access project/sandbox info
  const threadId = toolMessage?.thread_id || assistantMessage?.thread_id;
  const { data: thread } = useThread(threadId);

  // Prefer project prop, fallback to thread project
  const effectiveProject = project || thread?.project;
  const effectiveSandboxId = effectiveProject?.sandbox_id || effectiveProject?.sandbox?.id;

  const fallbackSandboxId = effectiveSandboxId || assistantMessage?.sandbox_id;
  const extractedData = extractImageEditData({ toolCall, toolResult }, fallbackSandboxId);
  const { mode, prompt, generatedImagePath, imagePath, imageUrl, width, height, error, success, sandboxId: extractedSandboxId } = extractedData;

  // Prefer extracted sandbox ID from tool output, fallback to project/message
  const sandboxId = extractedSandboxId || fallbackSandboxId;

  console.log('🖼️ [ImageEditToolView] Full extraction:', {
    mode,
    prompt,
    generatedImagePath,
    imagePath,
    imageUrl,
    sandboxId,
    extractedSandboxId,
    fallbackSandboxId,
    effectiveSandboxId,
    threadId,
    hasThread: !!thread,
    toolDataArgs: toolCall.arguments,
    toolDataResult: toolResult,
    projectSandboxId: project?.sandbox_id,
    threadProjectSandboxId: thread?.project?.sandbox_id,
    assistantSandboxId: assistantMessage?.sandbox_id
  });

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Wand2} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {mode === 'edit' ? 'Editing Image' : 'Generating Image'}
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

        {imageUrl ? (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Generated Image
            </Text>
            <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ aspectRatio: 1 }}>
              {imageLoading && (
                <View className="absolute inset-0 items-center justify-center bg-muted/30">
                  <ActivityIndicator size="large" color="#0066FF" />
                </View>
              )}
              {imageError ? (
                <View className="flex-1 items-center justify-center">
                  <Icon as={AlertCircle} size={32} className="text-muted-foreground mb-2" />
                  <Text className="text-sm font-roobert text-muted-foreground">
                    Failed to load image
                  </Text>
                </View>
              ) : (
                <RNImage
                  source={{ uri: imageUrl }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="contain"
                  onLoad={() => {
                    setImageLoading(false);
                    setImageError(false);
                  }}
                  onError={() => {
                    setImageLoading(false);
                    setImageError(true);
                  }}
                />
              )}
            </View>
          </View>
        ) : generatedImagePath ? (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Generated Image
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
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={Wand2} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              No Image Generated
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              The image could not be loaded
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

