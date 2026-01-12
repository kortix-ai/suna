import React, { useState, useEffect } from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Search, ExternalLink, Globe, CheckCircle2, AlertCircle, ImageIcon, ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWebSearchData, cleanUrl, getFavicon, extractQueriesFromToolCall } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import { DeepSearchLoadingState } from './DeepSearchLoadingState';
import * as Haptics from 'expo-haptics';
import { log } from '@/lib/logger';

// Utility functions
function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

export function WebSearchToolView({ toolCall, toolResult, isSuccess = true, isStreaming, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { query, results, images, success, isBatch, batchResults } = extractWebSearchData(toolCall, toolResult, isSuccess);
  const queriesArray = extractQueriesFromToolCall(toolCall);
  const isLoading = isStreaming && results.length === 0 && images.length === 0;
  const [currentQueryIndex, setCurrentQueryIndex] = useState(0);
  
  // Log for debugging
  log.log('[WebSearchToolView] Data:', {
    query,
    queryType: typeof query,
    queriesArray,
    queriesArrayLength: queriesArray.length,
    isBatch,
    batchResultsLength: batchResults?.length,
    isLoading,
    isStreaming,
    toolCallArgs: toolCall?.arguments,
  });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success && isSuccess);

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

  const currentResults = isBatch && batchResults && batchResults[currentQueryIndex]
    ? batchResults[currentQueryIndex].results
    : results;
  const currentImages = isBatch && batchResults && batchResults[currentQueryIndex]?.images
    ? batchResults[currentQueryIndex].images
    : images;
  const currentQuery = isBatch && batchResults && batchResults[currentQueryIndex]
    ? batchResults[currentQueryIndex].query
    : query;

  if (isLoading) {
    // Check for batch queries - either from queriesArray or from query being a JSON array
    let effectiveQueries = queriesArray;
    
    // Also check if query itself is a JSON array string
    if (effectiveQueries.length <= 1 && query && typeof query === 'string') {
      const trimmed = query.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed) && parsed.length > 1) {
            effectiveQueries = parsed.filter((q: any) => typeof q === 'string' && q.trim().length > 0);
          }
        } catch {
          // Not valid JSON
        }
      }
    }
    
    const hasBatchQueries = effectiveQueries.length > 1;
    
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: hasBatchQueries ? 'Deep Research' : toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: (
            <StatusBadge 
              variant="streaming" 
              label={hasBatchQueries ? `${effectiveQueries.length} queries` : 'Searching'} 
            />
          ),
        }}
      >
        <View className="flex-1 w-full">
          {hasBatchQueries ? (
            <DeepSearchLoadingState queries={effectiveQueries} />
          ) : (
            <LoadingState
              icon={toolMetadata.icon}
              iconColor={toolMetadata.iconColor}
              bgColor={toolMetadata.iconBgColor}
              title={name === 'image-search' ? 'Searching for images' : 'Searching the web'}
              filePath={currentQuery || 'Processing search...'}
              showProgress={true}
            />
          )}
        </View>
      </ToolViewCard>
    );
  }

  if (!isStreaming && results.length === 0 && images.length === 0) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: false,
          rightContent: (
            <StatusBadge
              variant={actualIsSuccess ? 'success' : 'error'}
              label={actualIsSuccess ? 'Completed' : 'Failed'}
            />
          ),
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Search} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            No Results Found
          </Text>
          {currentQuery && (
            <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
              <Text className="text-sm font-roobert text-foreground/60 text-center" numberOfLines={2}>
                {currentQuery}
              </Text>
            </View>
          )}
          <Text className="text-sm font-roobert text-muted-foreground mt-3 text-center">
            Try refining your search query
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: toolMetadata.subtitle.toUpperCase(),
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {currentQuery && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {currentQuery}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && !isStreaming && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
        <View className="px-4 py-4 gap-6">
          {/* Navigation Header - At the absolute top */}
          {isBatch && batchResults && batchResults.length > 1 && (
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
                  className={`h-8 w-8 items-center justify-center rounded-lg ${currentQueryIndex === 0 ? 'opacity-30' : 'active:bg-muted'}`}
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
                  className={`h-8 w-8 items-center justify-center rounded-lg ${currentQueryIndex === batchResults.length - 1 ? 'opacity-30' : 'active:bg-muted'}`}
                >
                  <Icon as={ChevronRight} size={18} className="text-foreground" />
                </Pressable>
              </View>
            </View>
          )}

          {currentImages.length > 0 && (
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
          )}

          {isBatch && batchResults ? (
            // Batch mode: display current query results
            <View className="gap-4">
              {batchResults[currentQueryIndex]?.answer && (
                <View className="bg-muted/50 border border-border rounded-xl p-3">
                  <Text className="text-sm font-roobert text-foreground leading-relaxed">
                    {batchResults[currentQueryIndex].answer}
                  </Text>
                </View>
              )}

              {currentResults.length > 0 ? (
                <View className="gap-2.5">
                  {currentResults.map((result: any, idx: number) => {
                    const favicon = getFavicon(result.url);

                    return (
                      <Pressable
                        key={`batch-${currentQueryIndex}-result-${idx}`}
                        onPress={() => handleOpenUrl(result.url)}
                        className="bg-card border border-border rounded-xl p-3.5 gap-2 active:opacity-70"
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
          ) : currentResults.length > 0 && (
            // Single query mode
            <View className="gap-4">
              {currentResults.map((result: any, idx: number) => {
                const favicon = getFavicon(result.url);

                return (
                  <Pressable
                    key={idx}
                    onPress={() => handleOpenUrl(result.url)}
                    className="bg-card border border-border rounded-xl p-3.5 gap-2 active:opacity-70"
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
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
