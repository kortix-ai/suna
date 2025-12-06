import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BookOpen, ExternalLink, Calendar, Users, Award, FileText } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractPaperDetailsData } from './_utils';
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

export function PaperDetailsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { paper, success } = extractPaperDetailsData({ toolCall, toolResult });

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
            title="Fetching Paper Details"
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (!paper) {
    return (
      <ToolViewCard
        header={{
          icon: toolMetadata.icon,
          iconColor: toolMetadata.iconColor,
          iconBgColor: toolMetadata.iconBgColor,
          subtitle: toolMetadata.subtitle.toUpperCase(),
          title: toolMetadata.title,
          isSuccess: false,
          isStreaming: false,
          rightContent: <StatusBadge variant="error" label="Not Found" />,
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
            <Icon as={BookOpen} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Paper Found
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            Unable to retrieve paper details
          </Text>
        </View>
      </ToolViewCard>
    );
  }

  const authorNames = paper.authors?.slice(0, 3).map(a => a.name).join(', ');
  const hasMoreAuthors = (paper.authors?.length || 0) > 3;

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
            label={actualIsSuccess ? 'Found' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {paper.title && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {paper.title}
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
          <Pressable
            onPress={() => handleOpenUrl(paper.url)}
            className="bg-card border border-border rounded-2xl p-4 gap-4 active:opacity-70"
          >
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="text-lg font-roobert-semibold text-foreground flex-1 pr-2">
                  {paper.title}
                </Text>
                <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
              </View>

              <View className="flex-row flex-wrap gap-2">
                {paper.year && (
                  <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-2 py-1 rounded">
                    <Icon as={Calendar} size={12} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert text-muted-foreground">
                      {paper.year}
                    </Text>
                  </View>
                )}

                {paper.is_open_access && (
                  <View className="bg-primary/10 border border-primary/20 px-2 py-1 rounded">
                    <Text className="text-xs font-roobert-medium text-primary">
                      Open Access
                    </Text>
                  </View>
                )}

                {paper.citation_count !== undefined && (
                  <View className="flex-row items-center gap-1.5 bg-muted/30 border border-border px-2 py-1 rounded">
                    <Icon as={Award} size={12} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert text-muted-foreground">
                      {paper.citation_count} citations
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {authorNames && (
              <View className="flex-row items-center gap-2 bg-muted/20 p-3 rounded-xl">
                <Icon as={Users} size={14} className="text-muted-foreground" />
                <Text className="text-sm font-roobert text-foreground flex-1">
                  {authorNames}{hasMoreAuthors ? ` +${paper.authors!.length - 3} more` : ''}
                </Text>
              </View>
            )}

            {paper.venue && (
              <View className="flex-row items-center gap-2 bg-muted/20 p-3 rounded-xl">
                <Icon as={FileText} size={14} className="text-muted-foreground" />
                <Text className="text-sm font-roobert text-foreground flex-1" numberOfLines={2}>
                  {paper.venue}
                </Text>
              </View>
            )}

            {(paper.abstract || paper.tldr) && (
              <View className="gap-2">
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  {paper.tldr ? 'TL;DR' : 'Abstract'}
                </Text>
                <Text className="text-sm font-roobert text-foreground/80" numberOfLines={6}>
                  {paper.tldr || paper.abstract}
                </Text>
              </View>
            )}

            {paper.fields_of_study && paper.fields_of_study.length > 0 && (
              <View className="flex-row flex-wrap gap-1.5">
                {paper.fields_of_study.slice(0, 5).map((field, idx) => (
                  <View key={idx} className="bg-primary/10 border border-primary/20 px-2 py-1 rounded">
                    <Text className="text-xs font-roobert text-primary">
                      {field}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {paper.pdf_url && (
              <Pressable
                onPress={() => handleOpenUrl(paper.pdf_url!)}
                className="bg-primary/10 border border-primary/20 rounded-xl p-3 flex-row items-center justify-center gap-2 active:opacity-70"
              >
                <Icon as={FileText} size={16} className="text-primary" />
                <Text className="text-sm font-roobert-medium text-primary">
                  View PDF
                </Text>
              </Pressable>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
