import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BookOpen, ExternalLink, Calendar, Users, FileText, Award } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPaperSearchData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import * as Haptics from 'expo-haptics';

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

const getSourceName = (url: string): string => {
  if (!url) return 'Source';
  try {
    const domain = url.toLowerCase();
    if (domain.includes('semanticscholar')) return 'Semantic Scholar';
    if (domain.includes('arxiv')) return 'arXiv';
    if (domain.includes('pubmed')) return 'PubMed';
    if (domain.includes('ieee')) return 'IEEE';
    if (domain.includes('acm')) return 'ACM';
    if (domain.includes('nature')) return 'Nature';
    if (domain.includes('springer')) return 'Springer';
    if (domain.includes('sciencedirect')) return 'ScienceDirect';

    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '');
    return hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
  } catch {
    return 'Source';
  }
};

export function PaperSearchToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { query, total_results, results, success } = extractPaperSearchData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const handleOpenUrl = (url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL(url);
  };

  if (isStreaming) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: actualIsSuccess,
          isStreaming: true,
          rightContent: <StatusBadge variant="streaming" label="Searching" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Searching Papers"
            filePath={query || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (results.length === 0) {
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
          showStatus: true,
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
            <Icon as={BookOpen} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Papers Found
          </Text>
          {query && (
            <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
              <Text className="text-sm font-roobert-mono text-foreground/60 text-center">
                {query}
              </Text>
            </View>
          )}
          <Text className="text-sm font-roobert text-muted-foreground text-center mt-3">
            Try refining your search criteria
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
        isStreaming: false,
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {query && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {query}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <ScrollView className="flex-1 w-full" showsVerticalScrollIndicator={false}>
        <View className="px-4 py-4 gap-6">
          {query && (
            <View className="pb-3 border-b border-border">
              <Text className="text-sm text-muted-foreground">
                Found {results.length} {results.length === 1 ? 'paper' : 'papers'} for "{query}"
              </Text>
            </View>
          )}
          <View className="gap-3">
            {results.map((result, idx) => {
              const sourceName = getSourceName(result.url);
              const authorNames = result.authors?.slice(0, 3).map(a => a.name).join(', ');
              const hasMoreAuthors = (result.authors?.length || 0) > 3;

              return (
                <Pressable
                  key={result.id || idx}
                  onPress={() => handleOpenUrl(result.url)}
                  className="bg-card border border-border rounded-2xl p-4 gap-3 active:opacity-70"
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-2">
                      <View className="flex-row items-center gap-2 flex-wrap">
                        <View className="bg-muted/30 border border-border px-3 py-1 rounded-full">
                          <Text className="text-xs font-roobert-mono text-foreground/60">
                            {sourceName}
                          </Text>
                        </View>
                        <Text className="text-xs text-muted-foreground">
                          #{idx + 1}
                        </Text>
                        {result.is_open_access && (
                          <View className="bg-primary/10 border border-primary/20 px-3 py-1 rounded-full">
                            <Text className="text-xs font-roobert-medium text-primary">
                              Open Access
                            </Text>
                          </View>
                        )}
                      </View>

                      <Text className="text-base font-roobert-semibold text-foreground" numberOfLines={3}>
                        {result.title}
                      </Text>
                    </View>

                    <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                  </View>

                  {result.abstract && (
                    <Text className="text-sm font-roobert text-foreground/70" numberOfLines={3}>
                      {result.abstract}
                    </Text>
                  )}

                  <View className="flex-row flex-wrap gap-2">
                    {result.year && (
                      <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                        <Icon as={Calendar} size={12} className="text-foreground/60" />
                        <Text className="text-xs font-roobert text-foreground/60">
                          {result.year}
                        </Text>
                      </View>
                    )}

                    {authorNames && (
                      <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full flex-1">
                        <Icon as={Users} size={12} className="text-foreground/60" />
                        <Text className="text-xs font-roobert text-foreground/60 flex-1" numberOfLines={1}>
                          {authorNames}{hasMoreAuthors ? '...' : ''}
                        </Text>
                      </View>
                    )}

                    {result.citation_count !== undefined && result.citation_count > 0 && (
                      <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                        <Icon as={Award} size={12} className="text-foreground/60" />
                        <Text className="text-xs font-roobert text-foreground/60">
                          {result.citation_count}
                        </Text>
                      </View>
                    )}
                  </View>

                  {result.venue && (
                    <View className="flex-row items-center gap-1.5">
                      <Icon as={FileText} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                        {result.venue}
                      </Text>
                    </View>
                  )}

                  {result.fields_of_study && result.fields_of_study.length > 0 && (
                    <View className="flex-row flex-wrap gap-1.5">
                      {result.fields_of_study.slice(0, 3).map((field, fieldIdx) => (
                        <View key={fieldIdx} className="bg-primary/10 border border-primary/20 px-3 py-1 rounded-full">
                          <Text className="text-xs font-roobert text-primary">
                            {field}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
