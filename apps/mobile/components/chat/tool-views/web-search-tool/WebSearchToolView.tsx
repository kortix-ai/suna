import React from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Search, ExternalLink, Globe, CheckCircle2, AlertCircle, ImageIcon } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWebSearchData, cleanUrl, getFavicon } from './_utils';
import * as Haptics from 'expo-haptics';

export function WebSearchToolView({ toolData, isStreaming }: ToolViewProps) {
  const { query, results, images, success } = extractWebSearchData(toolData);
  const isLoading = isStreaming && results.length === 0 && images.length === 0;

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <ActivityIndicator size="large" color="#0066FF" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Searching the web
        </Text>
        {query && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {query}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (!isStreaming && results.length === 0 && images.length === 0) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Search} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          No Results Found
        </Text>
        {query && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
              {query}
            </Text>
          </View>
        )}
        <Text className="text-sm font-roobert text-muted-foreground mt-3 text-center">
          Try refining your search query
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Globe} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Web Search
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {query || 'Search Results'}
            </Text>
          </View>
          {!isStreaming && (
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
          )}
        </View>

        {images.length > 0 && (
          <View className="gap-3">
            <View className="flex-row items-center gap-2">
              <Icon as={ImageIcon} size={16} className="text-foreground/50" />
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Images ({images.length})
              </Text>
            </View>
            <View className="flex-row flex-wrap gap-3">
              {images.slice(0, 6).map((imageUrl, idx) => (
                <Pressable
                  key={idx}
                  onPress={() => handleOpenUrl(imageUrl)}
                  className="relative overflow-hidden rounded-xl border border-border"
                  style={{ width: '47%', aspectRatio: 1 }}
                >
                  <RNImage
                    source={{ uri: imageUrl }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="cover"
                  />
                  <View className="absolute top-2 right-2 bg-black/60 rounded-lg p-1.5">
                    <Icon as={ExternalLink} size={12} className="text-white" />
                  </View>
                </Pressable>
              ))}
            </View>
            {images.length > 6 && (
              <Text className="text-xs font-roobert text-muted-foreground text-center mt-1">
                +{images.length - 6} more images
              </Text>
            )}
          </View>
        )}

        {results.length > 0 && (
          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Search Results ({results.length})
              </Text>
            </View>
            
            <View className="gap-3">
              {results.map((result, idx) => {
                const favicon = getFavicon(result.url);
                
                return (
                  <Pressable
                    key={idx}
                    onPress={() => handleOpenUrl(result.url)}
                    className="bg-card border border-border rounded-2xl p-4 gap-2"
                  >
                    <View className="flex-row items-start gap-3">
                      {favicon && (
                        <RNImage
                          source={{ uri: favicon }}
                          style={{ width: 20, height: 20, borderRadius: 4 }}
                        />
                      )}
                      <View className="flex-1 gap-1">
                        <Text 
                          className="text-base font-roobert-medium text-primary"
                          numberOfLines={2}
                        >
                          {result.title}
                        </Text>
                        <View className="flex-row items-center gap-1.5">
                          <Icon as={Globe} size={12} className="text-muted-foreground" />
                          <Text 
                            className="text-xs font-roobert text-muted-foreground flex-1"
                            numberOfLines={1}
                          >
                            {cleanUrl(result.url)}
                          </Text>
                        </View>
                      </View>
                      <Icon as={ExternalLink} size={16} className="text-muted-foreground" />
                    </View>
                    
                    {result.snippet && (
                      <Text 
                        className="text-sm font-roobert text-foreground/60 mt-1"
                        numberOfLines={3}
                      >
                        {result.snippet}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

