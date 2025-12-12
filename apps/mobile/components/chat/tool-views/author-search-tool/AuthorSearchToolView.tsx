import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { GraduationCap, ExternalLink, Building, Award, BookOpen, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAuthorSearchData } from './_utils';
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

export function AuthorSearchToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { query, total_results, results, success } = extractAuthorSearchData({ toolCall, toolResult });

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
            title="Searching Authors"
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
            <Icon as={GraduationCap} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Authors Found
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
          <View className="gap-3">
            {results.map((result, idx) => (
              <Pressable
                key={result.author_id || idx}
                onPress={() => handleOpenUrl(result.url)}
                className="bg-card border border-border rounded-2xl p-4 gap-3 active:opacity-70"
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-2">
                    <Text className="text-base font-roobert-semibold text-foreground">
                      {result.name}
                    </Text>

                    {result.affiliations && result.affiliations.length > 0 && (
                      <View className="flex-row items-center gap-1.5">
                        <Icon as={Building} size={12} className="text-muted-foreground" />
                        <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={2}>
                          {result.affiliations.join(', ')}
                        </Text>
                      </View>
                    )}
                  </View>

                  <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                </View>

                <View className="flex-row flex-wrap gap-2">
                  <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                    <Icon as={BookOpen} size={12} className="text-foreground/60" />
                    <Text className="text-xs font-roobert text-foreground/60">
                      {result.paper_count} papers
                    </Text>
                  </View>

                  <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                    <Icon as={Award} size={12} className="text-foreground/60" />
                    <Text className="text-xs font-roobert text-foreground/60">
                      {result.citation_count} citations
                    </Text>
                  </View>

                  <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                    <Icon as={Hash} size={12} className="text-foreground/60" />
                    <Text className="text-xs font-roobert text-foreground/60">
                      h-index: {result.h_index}
                    </Text>
                  </View>
                </View>

                {result.homepage && (
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      handleOpenUrl(result.homepage!);
                    }}
                    className="bg-primary/10 border border-primary/20 rounded-2xl p-3 flex-row items-center justify-center gap-2 active:opacity-70"
                  >
                    <Icon as={ExternalLink} size={14} className="text-primary" />
                    <Text className="text-xs font-roobert-medium text-primary">
                      Homepage
                    </Text>
                  </Pressable>
                )}
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
