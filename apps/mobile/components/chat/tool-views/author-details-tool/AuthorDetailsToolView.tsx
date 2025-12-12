import React from 'react';
import { View, ScrollView, Linking, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { GraduationCap, ExternalLink, Building, Award, BookOpen, Hash, User } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAuthorDetailsData } from './_utils';
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

export function AuthorDetailsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { author, success } = extractAuthorDetailsData({ toolCall, toolResult });

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
            title="Fetching Author Details"
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (!author) {
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
            <Icon as={GraduationCap} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Author Found
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            Unable to retrieve author details
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
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={actualIsSuccess ? 'Found' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {author.name && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {author.name}
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
            onPress={() => handleOpenUrl(author.url)}
            className="bg-card border border-border rounded-2xl p-4 gap-4 active:opacity-70"
          >
            <View className="flex-row items-start justify-between">
              <View className="flex-1 gap-3">
                <Text className="text-lg font-roobert-semibold text-foreground">
                  {author.name}
                </Text>

                {author.affiliations && author.affiliations.length > 0 && (
                  <View className="flex-row items-start gap-2 bg-muted/20 border border-border p-3 rounded-xl">
                    <Icon as={Building} size={14} className="text-foreground/60 flex-shrink-0 mt-0.5" />
                    <Text className="text-sm font-roobert text-foreground flex-1">
                      {author.affiliations.join(', ')}
                    </Text>
                  </View>
                )}

                <View className="flex-row flex-wrap gap-2">
                  <View className="bg-muted/30 border border-border rounded-xl p-3 flex-1">
                    <View className="flex-row items-center gap-2 mb-1">
                      <Icon as={BookOpen} size={14} className="text-foreground/60" />
                      <Text className="text-xs font-roobert-medium text-muted-foreground">Papers</Text>
                    </View>
                    <Text className="text-lg font-roobert-semibold text-foreground">
                      {author.paper_count}
                    </Text>
                  </View>

                  <View className="bg-muted/30 border border-border rounded-xl p-3 flex-1">
                    <View className="flex-row items-center gap-2 mb-1">
                      <Icon as={Award} size={14} className="text-foreground/60" />
                      <Text className="text-xs font-roobert-medium text-muted-foreground">Citations</Text>
                    </View>
                    <Text className="text-lg font-roobert-semibold text-foreground">
                      {author.citation_count}
                    </Text>
                  </View>

                  <View className="bg-muted/30 border border-border rounded-xl p-3 flex-1">
                    <View className="flex-row items-center gap-2 mb-1">
                      <Icon as={Hash} size={14} className="text-foreground/60" />
                      <Text className="text-xs font-roobert-medium text-muted-foreground">h-index</Text>
                    </View>
                    <Text className="text-lg font-roobert-semibold text-foreground">
                      {author.h_index}
                    </Text>
                  </View>
                </View>

                {author.homepage && (
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      handleOpenUrl(author.homepage!);
                    }}
                    className="bg-primary/10 border border-primary/20 rounded-xl p-3 flex-row items-center justify-center gap-2 active:opacity-70"
                  >
                    <Icon as={ExternalLink} size={16} className="text-primary" />
                    <Text className="text-sm font-roobert-medium text-primary">
                      Visit Homepage
                    </Text>
                  </Pressable>
                )}

                {author.aliases && author.aliases.length > 0 && (
                  <View className="bg-muted/20 border border-border p-3 rounded-xl gap-2">
                    <Text className="text-xs font-roobert-medium text-muted-foreground">Also known as:</Text>
                    <View className="flex-row flex-wrap gap-1.5">
                      {author.aliases.map((alias, idx) => (
                        <View key={idx} className="bg-card border border-border px-3 py-1 rounded-full">
                          <Text className="text-xs font-roobert text-foreground">
                            {alias}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>

              <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
            </View>
          </Pressable>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
