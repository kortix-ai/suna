import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Palette, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDesignerData } from './_utils';
import { FileAttachmentRenderer } from '@/components/chat/FileAttachmentRenderer';

export function DesignerToolView({ toolData, isStreaming = false, assistantMessage, project }: ToolViewProps) {
  const extractedData = extractDesignerData(toolData);
  const { mode, prompt, generatedImagePath, designUrl, width, height, error, success, sandboxId: extractedSandboxId } = extractedData;
  
  const sandboxId = extractedSandboxId || project?.sandbox_id || assistantMessage?.sandbox_id;
  
  console.log('🎨 [DesignerToolView] Data:', {
    generatedImagePath,
    sandboxId,
    extractedSandboxId,
    designUrl,
    args: toolData.arguments,
    output: toolData.result.output
  });

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Palette} size={40} className="text-purple-500 animate-pulse" />
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
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-red-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={AlertCircle} size={24} className="text-red-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground">
                Design Failed
              </Text>
            </View>
          </View>

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
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Palette} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xl font-roobert-semibold text-foreground">
              {mode === 'create' ? 'Design Created' : 'Design Edited'}
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

        {prompt && (
          <View className="bg-muted/50 rounded-xl p-4 border border-border">
            <View className="flex-row items-center gap-2 mb-2">
              <Icon as={Sparkles} size={14} className="text-purple-500" />
              <Text className="text-xs font-roobert-medium text-muted-foreground">Prompt</Text>
            </View>
            <Text className="text-sm font-roobert text-foreground" selectable>
              {prompt}
            </Text>
          </View>
        )}

        {(width || height) && (
          <View className="flex-row gap-2">
            {width && (
              <View className="bg-muted/30 rounded-xl p-3 border border-border flex-1">
                <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">Width</Text>
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {width}px
                </Text>
              </View>
            )}
            {height && (
              <View className="bg-muted/30 rounded-xl p-3 border border-border flex-1">
                <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">Height</Text>
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {height}px
                </Text>
              </View>
            )}
          </View>
        )}

        {generatedImagePath && sandboxId && (
          <FileAttachmentRenderer
            filePath={generatedImagePath}
            sandboxId={sandboxId}
            showName={false}
            showPreview={true}
          />
        )}
      </View>
    </ScrollView>
  );
}

