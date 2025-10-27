import React, { useState, useEffect } from 'react';
import { View, ScrollView, Image as RNImage, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Palette, CheckCircle2, AlertCircle, ImageOff, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDesignerData } from './_utils';
import { useSandboxImageBlob, blobToDataURL } from '@/lib/files/hooks';

export function DesignerToolView({ toolData, isStreaming = false, assistantMessage, project }: ToolViewProps) {
  const extractedData = extractDesignerData(toolData);
  const { mode, prompt, generatedImagePath, designUrl, width, height, error, success, sandboxId: extractedSandboxId } = extractedData;
  
  const sandboxId = extractedSandboxId || project?.sandbox_id || assistantMessage?.sandbox_id;
  
  const [imageError, setImageError] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  let normalizedPath = generatedImagePath;
  if (normalizedPath) {
    if (normalizedPath.startsWith('/workspace/')) {
      normalizedPath = normalizedPath.substring('/workspace/'.length);
    } else if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }
  }

  const { data: imageBlob, isLoading: imageLoading, error: imageLoadError } = useSandboxImageBlob(
    sandboxId,
    normalizedPath || undefined,
    { enabled: !!sandboxId && !!normalizedPath && !isStreaming }
  );

  useEffect(() => {
    if (imageBlob) {
      blobToDataURL(imageBlob)
        .then(dataUrl => {
          setBlobUrl(dataUrl);
        })
        .catch(err => {
          console.error('Failed to convert blob to data URL:', err);
          setImageError(true);
        });
    } else {
      setBlobUrl(null);
    }
  }, [imageBlob, generatedImagePath]);
  
  console.log('🎨 [DesignerToolView] Data:', {
    generatedImagePath,
    normalizedPath,
    sandboxId,
    extractedSandboxId,
    hasBlob: !!imageBlob,
    blobUrl,
    imageLoading,
    imageError,
    imageLoadError,
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

        {imageLoading && !blobUrl && (
          <View className="bg-card rounded-2xl overflow-hidden border border-border py-24 items-center justify-center">
            <ActivityIndicator size="large" color="#9333ea" />
            <Text className="text-sm font-roobert text-muted-foreground mt-4">
              Loading design...
            </Text>
          </View>
        )}

        {!imageLoading && blobUrl && !imageError && (
          <View className="bg-card rounded-2xl overflow-hidden border border-border">
            <RNImage
              source={{ uri: blobUrl }}
              style={{ 
                width: '100%', 
                aspectRatio: width && height ? width / height : 1,
                minHeight: 200 
              }}
              resizeMode="contain"
              onError={(e) => {
                console.error('Image load error:', e.nativeEvent);
                setImageError(true);
              }}
            />
          </View>
        )}

        {!imageLoading && !blobUrl && (imageError || imageLoadError) && (
          <View className="bg-card rounded-2xl overflow-hidden border border-border py-12 items-center">
            <View className="bg-red-500/10 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={ImageOff} size={32} className="text-red-500" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              Unable to Load Design
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center px-6 mb-2">
              {imageLoadError?.message || 'Image failed to load'}
            </Text>
            {normalizedPath && (
              <Text className="text-xs font-roobert-mono text-muted-foreground/60 text-center px-6">
                {normalizedPath}
              </Text>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

