import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Presentation, Folder } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
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

export function ListPresentationsToolView({
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
  const presentations = output?.presentations || [];
  const message = output?.message;
  const note = output?.note;
  const presentationsDirectory = output?.presentations_directory;

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
            title="Loading Presentations..."
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (presentations.length === 0) {
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
          <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
            <Icon as={Presentation} size={40} className="text-muted-foreground" />
          </View>
          <Text className="text-xl font-roobert-semibold text-foreground mb-2">
            No Presentations Yet
          </Text>
          {message && (
            <Text className="text-sm font-roobert text-muted-foreground text-center mb-4">
              {message}
            </Text>
          )}

          {presentationsDirectory && (
            <View className="bg-card border border-border rounded-2xl px-4 py-3 self-center">
              <View className="flex-row items-center gap-2">
                <Icon as={Folder} size={14} className="text-muted-foreground" />
                <Text className="text-sm font-roobert text-foreground/60" numberOfLines={1}>
                  {presentationsDirectory}
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
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {presentationsDirectory && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
              {presentationsDirectory.replace('/workspace/', '')}
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
          {message && (
            <View className="bg-card border border-border rounded-2xl p-4">
              <Text className="text-sm font-roobert text-foreground/80">
                {message}
              </Text>
            </View>
          )}

          <View className="gap-3">
            <View className="flex-row items-center justify-between mb-2">
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Presentations ({presentations.length})
              </Text>
            </View>

            {presentations.map((presentation: any, index: number) => (
              <View
                key={index}
                className="bg-card border border-border rounded-2xl p-4"
              >
                <View className="flex-row items-start gap-3">
                  <View className="bg-primary/10 rounded-xl p-2">
                    <Icon as={Presentation} size={20} className="text-primary" />
                  </View>
                  <View className="flex-1">
                    <Text className="text-base font-roobert-semibold text-foreground mb-1">
                      {presentation.name || presentation.presentation_name || 'Untitled'}
                    </Text>
                    {presentation.title && (
                      <Text className="text-sm font-roobert text-foreground/70 mb-2">
                        {presentation.title}
                      </Text>
                    )}
                    {presentation.description && (
                      <Text className="text-xs font-roobert text-muted-foreground mb-2">
                        {presentation.description}
                      </Text>
                    )}
                    <View className="flex-row items-center gap-4 mt-2">
                      {presentation.slide_count !== undefined && (
                        <Text className="text-xs font-roobert text-muted-foreground">
                          {presentation.slide_count} {presentation.slide_count === 1 ? 'slide' : 'slides'}
                        </Text>
                      )}
                      {presentation.created_at && (
                        <Text className="text-xs font-roobert text-muted-foreground">
                          Created {new Date(presentation.created_at).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                  </View>
                </View>
              </View>
            ))}
          </View>

          {note && (
            <View className="bg-primary/10 border border-primary/20 rounded-2xl p-4">
              <Text className="text-sm font-roobert text-primary">
                💡 {note}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
