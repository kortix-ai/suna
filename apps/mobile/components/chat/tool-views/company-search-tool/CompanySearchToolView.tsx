import React from 'react';
import { View, ScrollView, Linking, Pressable, Image as RNImage } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Building2, ExternalLink, MapPin, Briefcase } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCompanySearchData } from './_utils';
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

export function CompanySearchToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { query, total_results, results, success } = extractCompanySearchData({ toolCall, toolResult });

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
            title="Searching Companies"
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
            <Icon as={Building2} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-lg font-roobert-semibold text-foreground mb-2">
            No Companies Found
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
                Found {results.length} {results.length === 1 ? 'company' : 'companies'} for "{query}"
              </Text>
            </View>
          )}
          <View className="gap-3">
            {results.map((result, idx) => (
              <Pressable
                key={result.company_id || idx}
                onPress={() => result.url && handleOpenUrl(result.url)}
                className="bg-card border border-border rounded-2xl p-4 gap-3 active:opacity-70"
              >
                <View className="flex-row items-start gap-3">
                  {result.logo_url && (
                    <RNImage
                      source={{ uri: result.logo_url }}
                      style={{ width: 48, height: 48, borderRadius: 12 }}
                      resizeMode="contain"
                    />
                  )}
                  <View className="flex-1 gap-2">
                    <View className="flex-row items-start justify-between gap-2">
                      <Text className="text-base font-roobert-semibold text-foreground flex-1">
                        {result.name}
                      </Text>
                      {result.url && (
                        <Icon as={ExternalLink} size={16} className="text-muted-foreground flex-shrink-0" />
                      )}
                    </View>

                    {result.description && (
                      <Text className="text-sm font-roobert text-foreground/70" numberOfLines={2}>
                        {result.description}
                      </Text>
                    )}

                    {result.industry && (
                      <View className="flex-row items-center gap-1.5">
                        <Icon as={Briefcase} size={12} className="text-muted-foreground" />
                        <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                          {result.industry}
                        </Text>
                      </View>
                    )}

                    {result.location && (
                      <View className="flex-row items-center gap-1.5">
                        <Icon as={MapPin} size={12} className="text-muted-foreground" />
                        <Text className="text-sm font-roobert text-muted-foreground flex-1" numberOfLines={1}>
                          {result.location}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
