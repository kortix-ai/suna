import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ImageIcon, AlertCircle, CheckCircle2 } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { ToolViewCard, StatusBadge, LoadingState, ImageLoader } from '../shared';
import { getToolMetadata } from '../tool-metadata';

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

export function LoadImageToolView({
    toolCall,
    toolResult,
    isStreaming,
    assistantTimestamp,
    toolTimestamp,
}: ToolViewProps) {
    if (!toolCall) {
      return null;
    }

    const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
    const toolMetadata = getToolMetadata(name, toolCall.arguments);
    const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

    const output = typeof toolResult?.output === 'object' ? toolResult.output : {};
    const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : {};

    const imageUrl = output?.image_url;
    const filePath = output?.file_path || args?.file_path;
    const message = output?.message;

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
                rightContent: <StatusBadge variant="streaming" label="Loading" />,
              }}
            >
              <View className="flex-1 w-full">
                <LoadingState
                  icon={toolMetadata.icon}
                  iconColor={toolMetadata.iconColor}
                  bgColor={toolMetadata.iconBgColor}
                  title="Loading image..."
                  filePath={filePath || undefined}
                  showProgress={false}
                />
              </View>
            </ToolViewCard>
        );
    }

    if (!imageUrl) {
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
                    label={actualIsSuccess ? 'Loaded' : 'Failed'}
                  />
                ),
              }}
            >
              <View className="flex-1 w-full items-center justify-center py-12 px-6">
                  <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
                      <Icon as={actualIsSuccess ? CheckCircle2 : AlertCircle} size={40} className="text-muted-foreground" />
                  </View>
                  <Text className="text-xl font-roobert-semibold text-foreground mb-2">
                      {actualIsSuccess ? 'Image loaded' : 'Failed to load image'}
                  </Text>
                  {message && (
                      <Text className="text-sm font-roobert text-muted-foreground text-center mb-4">
                          {message}
                      </Text>
                  )}
                  {filePath && (
                      <View className="bg-card border border-border rounded-2xl px-4 py-3 w-full">
                          <View className="flex-row items-center gap-2">
                              <Icon as={ImageIcon} size={14} className="text-muted-foreground" />
                              <Text className="text-sm font-roobert text-foreground/60 flex-1" numberOfLines={1}>
                                  {filePath}
                              </Text>
                          </View>
                      </View>
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
            rightContent: (
              <StatusBadge
                variant={actualIsSuccess ? 'success' : 'error'}
                label="Loaded"
              />
            ),
          }}
          footer={
            <View className="flex-row items-center justify-between w-full">
              {filePath && (
                <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
                  {filePath}
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
                      <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ aspectRatio: 1 }}>
                          <ImageLoader
                            source={{ uri: imageUrl }}
                            className="w-full h-full"
                            showLoadingState={true}
                            resizeMode="contain"
                          />
                      </View>

                      {message && (
                          <View className="bg-card border border-border rounded-2xl p-4">
                              <Text className="text-sm font-roobert text-foreground/80">
                                  {message}
                              </Text>
                          </View>
                      )}
                  </View>
              </View>
          </ScrollView>
        </ToolViewCard>
    );
}
