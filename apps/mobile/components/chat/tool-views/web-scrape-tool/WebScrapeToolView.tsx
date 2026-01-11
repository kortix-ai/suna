import React, { useState } from 'react';
import { View, ScrollView, Image as RNImage, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Globe, FileText, Copy, Check, Calendar, Zap, ExternalLink } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWebScrapeData, formatFileInfo, formatDomain, getFavicon } from './_utils';
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

export function WebScrapeToolView({ toolCall, toolResult, isStreaming, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { url, files, message, urlCount, success } = extractWebScrapeData({ toolCall, toolResult });
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const domain = url ? formatDomain(url) : 'Unknown';
  const favicon = url ? getFavicon(url) : null;

  const copyFilePath = async (filePath: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(filePath);
    setCopiedFile(filePath);
    setTimeout(() => setCopiedFile(null), 2000);
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
          rightContent: <StatusBadge variant="streaming" label="Extracting" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Extracting Content"
            subtitle="Analyzing and processing"
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
        showStatus: true,
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
              <View className="flex-row items-center gap-3">
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

          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Icon as={Zap} size={16} className="text-foreground/50" />
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  Generated Files
                </Text>
              </View>
              <View className="bg-muted/30 rounded-full px-3 py-1">
                <Text className="text-xs font-roobert-medium text-foreground/60">
                  {files.length} file{files.length !== 1 ? 's' : ''}
                </Text>
              </View>
            </View>

            {files.length > 0 ? (
              <View className="gap-3">
                {files.map((filePath, idx) => {
                  const fileInfo = formatFileInfo(filePath);
                  const isCopied = copiedFile === filePath;

                  return (
                    <View
                      key={idx}
                      className="bg-card border border-border rounded-2xl p-4"
                    >
                      <View className="flex-row items-start gap-3">
                        <View className="bg-muted/30 border border-border rounded-xl items-center justify-center" style={{ width: 40, height: 40 }}>
                          <Icon as={FileText} size={20} className="text-foreground/60" />
                        </View>

                        <View className="flex-1 gap-2">
                          <View className="flex-row items-center gap-2 flex-wrap">
                            <View className="bg-muted/30 border border-border rounded-full px-3 py-1">
                              <Text className="text-xs font-roobert-medium text-foreground/60">
                                JSON
                              </Text>
                            </View>
                            {fileInfo.timestamp && (
                              <View className="bg-muted/30 border border-border rounded-full px-3 py-1 flex-row items-center gap-1">
                                <Icon as={Calendar} size={10} className="text-foreground/60" />
                                <Text className="text-xs font-roobert text-foreground/60">
                                  {fileInfo.timestamp.replace('_', ' ')}
                                </Text>
                              </View>
                            )}
                          </View>

                          <Text className="text-sm font-roobert-medium text-foreground">
                            {fileInfo.fileName}
                          </Text>
                          <Text className="text-xs font-roobert text-muted-foreground" numberOfLines={2}>
                            {fileInfo.fullPath}
                          </Text>
                        </View>

                        <Pressable
                          onPress={() => copyFilePath(filePath)}
                          className="bg-muted/30 border border-border rounded-lg p-1.5 active:opacity-70"
                        >
                          <Icon
                            as={isCopied ? Check : Copy}
                            size={14}
                            className={isCopied ? 'text-primary' : 'text-foreground/60'}
                          />
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <View className="items-center justify-center py-8 bg-muted/10 rounded-2xl">
                <Icon as={FileText} size={32} className="text-muted-foreground mb-2" />
                <Text className="text-sm font-roobert text-muted-foreground">
                  No files generated
                </Text>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
