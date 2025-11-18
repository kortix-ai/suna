import React, { useState, useEffect } from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Search, ExternalLink, Globe, CheckCircle2, AlertCircle, ImageIcon, ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWebSearchData, cleanUrl, getFavicon } from './_utils';
import * as Haptics from 'expo-haptics';

export function WebSearchToolView({ toolData, isStreaming }: ToolViewProps) {
  const { query, results, images, success, isBatch, batchResults } = extractWebSearchData(toolData);
  const isLoading = isStreaming && results.length === 0 && images.length === 0;
  const [currentQueryIndex, setCurrentQueryIndex] = useState(0);

  // Reset to first query when batch results change
  useEffect(() => {
    if (isBatch && batchResults && batchResults.length > 0) {
      setCurrentQueryIndex(0);
    }
  }, [isBatch, batchResults?.length]);

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

        {/* Navigation Header - At the absolute top */}
        {isBatch && batchResults && (
          <View className="flex-row items-center justify-between pb-4 mb-4 border-b border-border">
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-2 mb-1">
                <Text className="text-xs font-roobert-medium text-muted-foreground">
                  Query {currentQueryIndex + 1} of {batchResults.length}
                </Text>
                <Icon 
                  as={batchResults[currentQueryIndex].success ? CheckCircle2 : AlertCircle} 
                  size={12} 
                  className={batchResults[currentQueryIndex].success ? 'text-primary' : 'text-destructive'} 
                />
                {batchResults[currentQueryIndex].results.length > 0 && (
                  <View className="bg-muted px-1.5 py-0.5 rounded">
                    <Text className="text-xs font-roobert-medium text-muted-foreground">
                      {batchResults[currentQueryIndex].results.length}
                    </Text>
                  </View>
                )}
              </View>
              <Text className="text-sm font-roobert-medium text-foreground" numberOfLines={1}>
                {batchResults[currentQueryIndex].query}
              </Text>
            </View>
            
            <View className="flex-row items-center gap-1 ml-3">
              <Pressable
                onPress={() => {
                  if (currentQueryIndex > 0) {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setCurrentQueryIndex(currentQueryIndex - 1);
                  }
                }}
                disabled={currentQueryIndex === 0}
                className={`h-8 w-8 items-center justify-center rounded-lg ${
                  currentQueryIndex === 0 ? 'opacity-30' : 'active:bg-muted'
                }`}
              >
                <Icon as={ChevronLeft} size={18} className="text-foreground" />
              </Pressable>
              <Pressable
                onPress={() => {
                  if (currentQueryIndex < batchResults.length - 1) {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setCurrentQueryIndex(currentQueryIndex + 1);
                  }
                }}
                disabled={currentQueryIndex === batchResults.length - 1}
                className={`h-8 w-8 items-center justify-center rounded-lg ${
                  currentQueryIndex === batchResults.length - 1 ? 'opacity-30' : 'active:bg-muted'
                }`}
              >
                <Icon as={ChevronRight} size={18} className="text-foreground" />
              </Pressable>
            </View>
          </View>
        )}

        {(() => {
          const currentImages = isBatch && batchResults && batchResults[currentQueryIndex]?.images
            ? batchResults[currentQueryIndex].images
            : images;
          return currentImages.length > 0 && (
          <View className="gap-3">
            <View className="flex-row items-center gap-2">
              <Icon as={ImageIcon} size={16} className="text-foreground/50" />
              <Text className="text-sm font-roobert-medium text-foreground/70">
                  Images ({currentImages.length})
                </Text>
                {isBatch && batchResults && (
                  <Text className="text-xs font-roobert text-muted-foreground">
                    (Query {currentQueryIndex + 1})
              </Text>
                )}
            </View>
            <View className="flex-row flex-wrap gap-3">
                {currentImages.slice(0, 6).map((imageUrl, idx) => (
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
              {currentImages.length > 6 && (
              <Text className="text-xs font-roobert text-muted-foreground text-center mt-1">
                  +{currentImages.length - 6} more images
              </Text>
            )}
            </View>
          );
        })()}

        {isBatch && batchResults ? (
          // Batch mode: display current query results
          <View className="gap-4">

            {/* Current Query Results */}
            {(() => {
              const batchItem = batchResults[currentQueryIndex];
              return (
                <View className="gap-4">
                  {batchItem.answer && (
                    <View className="bg-muted/50 border border-border rounded-xl p-3">
                      <Text className="text-sm font-roobert text-foreground leading-relaxed">
                        {batchItem.answer}
                      </Text>
          </View>
        )}

                  {batchItem.results.length > 0 ? (
                    <View className="gap-2.5">
                      {batchItem.results.map((result, idx) => {
                        const favicon = getFavicon(result.url);
                        
                        return (
                          <Pressable
                            key={`batch-${currentQueryIndex}-result-${idx}`}
                            onPress={() => handleOpenUrl(result.url)}
                            className="bg-card border border-border rounded-xl p-3.5 gap-2"
                          >
                            <View className="flex-row items-start gap-2.5">
                              {favicon && (
                                <RNImage
                                  source={{ uri: favicon }}
                                  style={{ width: 18, height: 18, borderRadius: 3 }}
                                />
                              )}
                              <View className="flex-1 gap-1">
                                <Text 
                                  className="text-sm font-roobert-medium text-primary"
                                  numberOfLines={2}
                                >
                                  {result.title}
                                </Text>
                                <View className="flex-row items-center gap-1.5">
                                  <Icon as={Globe} size={11} className="text-muted-foreground" />
                                  <Text 
                                    className="text-xs font-roobert text-muted-foreground flex-1"
                                    numberOfLines={1}
                                  >
                                    {cleanUrl(result.url)}
                                  </Text>
                                </View>
                              </View>
                              <Icon as={ExternalLink} size={14} className="text-muted-foreground" />
                            </View>
                            
                            {result.snippet && (
                              <Text 
                                className="text-xs font-roobert text-foreground/60 mt-1"
                                numberOfLines={2}
                              >
                                {result.snippet}
                              </Text>
                            )}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : (
                    <Text className="text-sm font-roobert text-muted-foreground italic py-4 text-center">
                      No results found for this query
                    </Text>
                  )}
                </View>
              );
            })()}
          </View>
        ) : results.length > 0 && (
          // Single query mode: original display
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

