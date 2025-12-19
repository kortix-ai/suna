import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BookOpen, ExternalLink, Calendar, Award, FileText } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAuthorPapersData } from './_utils';
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

export function AuthorPapersToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { author_name, total_papers, papers, success } = extractAuthorPapersData({ toolCall, toolResult });

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
          rightContent: <StatusBadge variant="streaming" label="Fetching" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Fetching Author Papers"
            filePath={author_name || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (papers.length === 0) {
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
          {author_name && (
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              {author_name}
            </Text>
          )}
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
          {author_name && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {author_name}
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
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert-medium text-muted-foreground mb-1">
              Total Publications
            </Text>
            <Text className="text-2xl font-roobert-semibold text-foreground">
              {total_papers}
            </Text>
          </View>

          <View className="gap-3">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Publications ({papers.length})
            </Text>
            {papers.map((paper, idx) => (
              <Pressable
                key={paper.paper_id || idx}
                onPress={() => handleOpenUrl(paper.url)}
                className="bg-card border border-border rounded-2xl p-4 gap-3 active:opacity-70"
              >
                <View className="flex-row items-start justify-between gap-3">
                  <View className="flex-1 gap-2">
                    <Text className="text-base font-roobert-semibold text-foreground" numberOfLines={3}>
                      {paper.title}
                    </Text>

                    <View className="flex-row flex-wrap gap-2">
                      {paper.year && (
                        <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                          <Icon as={Calendar} size={12} className="text-foreground/60" />
                          <Text className="text-xs font-roobert text-foreground/60">
                            {paper.year}
                          </Text>
                        </View>
                      )}

                      {paper.citation_count !== undefined && (
                        <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-3 py-1 rounded-full">
                          <Icon as={Award} size={12} className="text-foreground/60" />
                          <Text className="text-xs font-roobert text-foreground/60">
                            {paper.citation_count}
                          </Text>
                        </View>
                      )}
                    </View>

                    {paper.venue && (
                      <View className="flex-row items-center gap-1.5">
                        <Icon as={FileText} size={12} className="text-muted-foreground" />
                        <Text className="text-xs font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                          {paper.venue}
                        </Text>
                      </View>
                    )}
                  </View>

                  <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
