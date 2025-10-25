import React, { useState, useEffect } from 'react';
import { View, ScrollView, ActivityIndicator, Image as RNImage, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MonitorPlay, Globe, CheckCircle2, AlertCircle, ExternalLink, Code2, ImageIcon } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractBrowserData } from './_utils';
import * as Haptics from 'expo-haptics';

export function BrowserToolView({ 
  toolData, 
  assistantMessage, 
  toolMessage, 
  isStreaming,
  project 
}: ToolViewProps) {
  const browserData = extractBrowserData(toolData, toolMessage, assistantMessage);
  const { url, operation, screenshotUrl, screenshotBase64, parameters, result } = browserData;
  
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const isSuccess = toolData.result.success ?? true;
  const isLoading = isStreaming;

  useEffect(() => {
    if (screenshotUrl || screenshotBase64) {
      setImageLoading(true);
      setImageError(false);
    }
  }, [screenshotUrl, screenshotBase64]);

  const toggleContext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowContext(!showContext);
  };

  const renderScreenshot = () => {
    const imageSource = screenshotUrl
      ? { uri: screenshotUrl }
      : screenshotBase64
      ? { uri: `data:image/png;base64,${screenshotBase64}` }
      : null;

    if (!imageSource) return null;

    return (
      <View className="gap-3">
        <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ aspectRatio: 16/10 }}>
          {imageLoading && (
            <View className="absolute inset-0 items-center justify-center bg-muted/30">
              <ActivityIndicator size="large" color="#0066FF" />
            </View>
          )}
          {imageError ? (
            <View className="flex-1 items-center justify-center">
              <Icon as={AlertCircle} size={32} className="text-muted-foreground mb-2" />
              <Text className="text-sm font-roobert text-muted-foreground">
                Failed to load screenshot
              </Text>
            </View>
          ) : (
            <RNImage
              source={imageSource}
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

        {url && (
          <View className="flex-row items-center gap-2 px-3 py-2 bg-muted/30 rounded-xl">
            <Icon as={Globe} size={14} className="text-muted-foreground" />
            <Text className="text-xs font-roobert text-muted-foreground flex-1" numberOfLines={1}>
              {url}
            </Text>
          </View>
        )}
      </View>
    );
  };

  const renderContext = () => {
    if (!parameters && !result) return null;

    return (
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="gap-4">
          {parameters && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                Input
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text className="text-sm font-roobert text-foreground/80" selectable>
                    {JSON.stringify(parameters, null, 2)}
                  </Text>
                </ScrollView>
              </View>
            </View>
          )}

          {result && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                Output
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text className="text-sm font-roobert text-foreground/80" selectable>
                    {JSON.stringify(result, null, 2)}
                  </Text>
                </ScrollView>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    );
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <ActivityIndicator size="large" color="#0066FF" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {operation} in progress
        </Text>
        {url && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {url}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (!screenshotUrl && !screenshotBase64 && !showContext) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={MonitorPlay} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Browser action completed
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center mb-4">
          Screenshot will appear when available
        </Text>
        {url && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 w-full">
            <View className="flex-row items-center gap-2">
              <Icon as={Globe} size={14} className="text-muted-foreground" />
              <Text className="text-sm font-roobert text-foreground/60 flex-1" numberOfLines={1}>
                {url}
              </Text>
            </View>
          </View>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={MonitorPlay} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Browser
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {operation}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {!isStreaming && (
              <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
                isSuccess ? 'bg-primary/10' : 'bg-destructive/10'
              }`}>
                <Icon 
                  as={isSuccess ? CheckCircle2 : AlertCircle} 
                  size={12} 
                  className={isSuccess ? 'text-primary' : 'text-destructive'} 
                />
                <Text className={`text-xs font-roobert-medium ${
                  isSuccess ? 'text-primary' : 'text-destructive'
                }`}>
                  {isSuccess ? 'Done' : 'Failed'}
                </Text>
              </View>
            )}
            {(result || parameters) && (
              <Pressable
                onPress={toggleContext}
                className="bg-muted/30 rounded-xl p-2"
              >
                <Icon 
                  as={showContext ? ImageIcon : Code2} 
                  size={16} 
                  className="text-foreground/60" 
                />
              </Pressable>
            )}
          </View>
        </View>

        {showContext ? renderContext() : renderScreenshot()}
      </View>
    </ScrollView>
  );
}

