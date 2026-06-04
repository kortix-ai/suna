import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Quote, ExternalLink, Calendar, Users, Award } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPaperCitationsData } from './_utils';
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

export function PaperCitationsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { paper_title, total_citations, citations, success } = extractPaperCitationsData({ toolCall, toolResult });

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
            title="Fetching Citations"
            filePath={paper_title || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (citations.length === 0) {
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
            <Icon as={Quote} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Citations Found
          </Text>
          {paper_title && (
            <Text className="text-sm font-roobert text-muted-foreground text-center px-6">
              {paper_title}
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
          {paper_title && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {paper_title}
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
          {paper_title && (
            <View className="bg-muted/30 rounded-xl p-4 border border-border">
              <Text className="text-xs font-roobert-medium text-muted-foreground mb-2">
                Paper
              </Text>
              <Text className="text-sm font-roobert-semibold text-foreground">
                {paper_title}
              </Text>
            </View>
          )}

          <View className="gap-3">
            {citations.map((citation, idx) => {
              const authorNames = citation.authors.slice(0, 2).join(', ');
              const hasMoreAuthors = citation.authors.length > 2;

              return (
                <Pressable
                  key={citation.paper_id || idx}
                  onPress={() => citation.url && handleOpenUrl(citation.url)}
                  className="bg-card border border-border rounded-2xl p-4 gap-3 active:opacity-70"
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-2">
                      <Text className="text-base font-roobert-semibold text-foreground" numberOfLines={3}>
                        {citation.title}
                      </Text>

                      {authorNames && (
                        <View className="flex-row items-center gap-1.5">
                          <Icon as={Users} size={12} className="text-muted-foreground" />
                          <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                            {authorNames}{hasMoreAuthors ? ` +${citation.authors.length - 2}` : ''}
                          </Text>
                        </View>
                      )}

                      <View className="flex-row flex-wrap gap-2">
                        {citation.year && (
                          <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-2 py-1 rounded">
                            <Icon as={Calendar} size={12} className="text-muted-foreground" />
                            <Text className="text-xs font-roobert text-muted-foreground">
                              {citation.year}
                            </Text>
                          </View>
                        )}

                        {citation.citation_count !== undefined && (
                          <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-2 py-1 rounded">
                            <Icon as={Award} size={12} className="text-muted-foreground" />
                            <Text className="text-xs font-roobert text-muted-foreground">
                              {citation.citation_count}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>

                    {citation.url && (
                      <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
