import React, { useState, useEffect } from 'react';
import { View, ScrollView, Image as RNImage, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Wand2, CheckCircle2, AlertCircle, ImageOff, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractImageEditData } from './_utils';
import { useSandboxImageBlob } from '@/lib/files/hooks';

export function ImageEditToolView({ toolData, isStreaming = false, assistantMessage, project }: ToolViewProps) {
  const sandboxId = project?.sandbox_id || assistantMessage?.sandbox_id;
  const extractedData = extractImageEditData(toolData, sandboxId);
  const { mode, prompt, generatedImagePath, imagePath, width, height, error, success } = extractedData;
  
  const [imageError, setImageError] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const { data: imageBlob, isLoading: imageLoading } = useSandboxImageBlob(
    sandboxId,
    generatedImagePath || undefined,
    { enabled: !!sandboxId && !!generatedImagePath && !isStreaming }
  );

  useEffect(() => {
    if (imageBlob) {
      const url = URL.createObjectURL(imageBlob);
      setBlobUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [imageBlob]);
  
  console.log('🖼️ [ImageEditToolView] Data:', {
    generatedImagePath,
    sandboxId,
    hasBlob: !!imageBlob,
    blobUrl,
    args: toolData.arguments,
    output: toolData.result.output
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
        <View className="px-6 py-4 gap-6">
          <View className="flex-row items-center gap-3">
            <View className="bg-red-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
              <Icon as={AlertCircle} size={24} className="text-red-500" />
            </View>
            <View className="flex-1">
              <Text className="text-xl font-roobert-semibold text-foreground">
                Generation Failed
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
            <Icon as={Wand2} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              AI Image
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {mode === 'edit' ? 'Edited' : 'Generated'}
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

        {blobUrl && !imageError ? (
          <View className="bg-card rounded-2xl overflow-hidden border border-border">
            <View style={{ position: 'relative', width: '100%', aspectRatio: width && height ? width / height : 1 }}>
              {imageLoading && (
                <View className="absolute inset-0 items-center justify-center bg-muted/30">
                  <ActivityIndicator size="large" color="#9333ea" />
                </View>
              )}
              <RNImage
                source={{ uri: blobUrl }}
                style={{ width: '100%', height: '100%' }}
                resizeMode="contain"
                onError={() => setImageError(true)}
              />
            </View>
          </View>
        ) : imageError || (!blobUrl && !imageLoading) ? (
          <View className="py-8 items-center">
            <View className="bg-red-500/10 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={ImageOff} size={32} className="text-red-500" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              Unable to Load Image
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center px-6">
              {generatedImagePath || 'No image path provided'}
            </Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

