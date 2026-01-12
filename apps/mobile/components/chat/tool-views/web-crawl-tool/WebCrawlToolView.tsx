import React, { useState } from 'react';
import { View, ScrollView, Image as RNImage, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Globe, FileText, Copy, Check, ExternalLink } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWebCrawlData, getContentStats, formatDomain, getFavicon } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';
import * as Clipboard from 'expo-clipboard';
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

export function WebCrawlToolView({ toolCall, toolResult, isStreaming, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { url, content, success } = extractWebCrawlData({ toolCall, toolResult });
  const [copied, setCopied] = useState(false);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const stats = getContentStats(content);
  const domain = url ? formatDomain(url) : 'Unknown';
  const favicon = url ? getFavicon(url) : null;

  const copyContent = async () => {
    if (!content) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenUrl = async () => {
    if (!url) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      }
    } catch (err) {
      log.error('Failed to open URL:', err);
    }
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
          rightContent: <StatusBadge variant="streaming" label="Crawling" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Crawling Webpage"
            subtitle="Fetching content from"
            filePath={domain || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (!url) {
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
          rightContent: <StatusBadge variant="error" label="Failed" />,
        }}
      >
        <View className="flex-1 w-full items-center justify-center py-12 px-6">
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Globe} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            No URL Detected
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            Unable to extract a valid URL
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
            label={actualIsSuccess ? 'Completed' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <Pressable
            onPress={handleOpenUrl}
            className="flex-row items-center gap-1.5 flex-1 min-w-0 active:opacity-70"
          >
            <Icon as={Globe} size={12} className="text-primary" />
            <Text className="text-xs text-primary flex-1" numberOfLines={1}>
              {url}
            </Text>
            <Icon as={ExternalLink} size={12} className="text-primary" />
          </Pressable>
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
            <View className="flex-row items-center gap-2">
              <Icon as={Globe} size={16} className="text-foreground/50" />
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Source URL
              </Text>
            </View>

            <View className="bg-card border border-border rounded-2xl p-4">
              <View className="flex-row items-center gap-3 mb-2">
                {favicon && (
                  <RNImage
                    source={{ uri: favicon }}
                    style={{ width: 24, height: 24, borderRadius: 6 }}
                  />
                )}
                <View className="flex-1">
                  <Text className="text-sm font-roobert-medium text-foreground" numberOfLines={2}>
                    {url}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground mt-1">
                    {domain}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {content ? (
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <Icon as={FileText} size={16} className="text-foreground/50" />
                  <Text className="text-sm font-roobert-medium text-foreground/70">
                    Extracted Content
                  </Text>
                </View>
                <View className="flex-row items-center gap-2">
                  <View className="bg-muted/30 rounded-lg px-2 py-1">
                    <Text className="text-xs font-roobert-medium text-foreground/60">
                      {stats.wordCount} words
                    </Text>
                  </View>
                  <Pressable
                    onPress={copyContent}
                    className="bg-muted/30 rounded-lg p-1.5 active:opacity-70"
                  >
                    <Icon
                      as={copied ? Check : Copy}
                      size={14}
                      className={copied ? 'text-primary' : 'text-foreground/60'}
                    />
                  </Pressable>
                </View>
              </View>

              <View className="bg-card border border-border rounded-2xl overflow-hidden">
                <View className="bg-muted/30 px-4 py-3 border-b border-border flex-row items-center justify-between">
                  <View className="flex-row items-center gap-2">
                    <View className="bg-primary/10 rounded-lg p-1.5">
                      <Icon as={FileText} size={14} className="text-primary" />
                    </View>
                    <View>
                      <Text className="text-sm font-roobert-medium text-foreground">
                        Page Content
                      </Text>
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {stats.lineCount} lines
                      </Text>
                    </View>
                  </View>
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {stats.charCount} chars
                  </Text>
                </View>

                <ScrollView
                  className="p-4"
                  style={{ maxHeight: 400 }}
                  showsVerticalScrollIndicator={true}
                >
                  <Text className="text-xs font-roobert text-foreground/80" selectable>
                    {content}
                  </Text>
                </ScrollView>
              </View>
            </View>
          ) : (
            <View className="items-center justify-center py-12 px-6 bg-muted/10 rounded-2xl">
              <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                <Icon as={FileText} size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-lg font-roobert-semibold text-foreground mb-2">
                No Content Extracted
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                The webpage might be restricted or empty
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
