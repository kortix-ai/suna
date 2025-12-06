import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Palette } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDesignerData } from './_utils';
import { FileAttachmentsGrid } from '@/components/chat';
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

export function DesignerToolView({ toolCall, toolResult, isStreaming = false, assistantMessage, project, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const extractedData = extractDesignerData({ toolCall, toolResult });
  const { mode, prompt, generatedImagePath, designUrl, width, height, error, success, sandboxId: extractedSandboxId } = extractedData;

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const sandboxId = extractedSandboxId || project?.sandbox?.id || assistantMessage?.sandbox_id;

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
          rightContent: <StatusBadge variant="streaming" label="Creating" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title={mode === 'create' ? 'Creating Design' : 'Editing Design'}
            filePath={prompt || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (error) {
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
        <View className="flex-1 w-full px-4 py-4">
          <View className="bg-destructive/10 rounded-xl p-4 border border-destructive/20">
            <Text className="text-sm font-roobert text-destructive">
              {error}
            </Text>
          </View>
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
            label={actualIsSuccess ? 'Generated' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {prompt && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {prompt}
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
          {prompt && (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Prompt
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert text-foreground/90" selectable>
                  {prompt}
                </Text>
              </View>
            </View>
          )}

          {(width || height) && (
            <View className="flex-row gap-2">
              {width && (
                <View className="bg-card border border-border rounded-2xl p-3 flex-1">
                  <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">Width</Text>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {width}px
                  </Text>
                </View>
              )}
              {height && (
                <View className="bg-card border border-border rounded-2xl p-3 flex-1">
                  <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">Height</Text>
                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {height}px
                  </Text>
                </View>
              )}
            </View>
          )}

          {generatedImagePath && sandboxId ? (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Generated Design
              </Text>
              <FileAttachmentsGrid
                filePaths={[generatedImagePath]}
                sandboxId={sandboxId}
                sandboxUrl={project?.sandbox?.sandbox_url}
                compact={false}
                showPreviews={true}
              />
            </View>
          ) : designUrl ? (
            <View className="gap-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Generated Design
              </Text>
              <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ aspectRatio: width && height ? width / height : 1 }}>
                <ImageLoader
                  source={{ uri: designUrl }}
                  className="w-full h-full"
                  showLoadingState={true}
                  resizeMode="contain"
                />
              </View>
            </View>
          ) : (
            <View className="py-8 items-center">
              <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                <Icon as={Palette} size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-base font-roobert-medium text-foreground mb-1">
                No Design Generated
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                The design could not be loaded
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
