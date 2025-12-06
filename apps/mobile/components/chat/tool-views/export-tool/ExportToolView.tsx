import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
    FileText,
    Presentation,
    Download,
    Layers
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractExportData } from './_utils';
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

export function ExportToolView({
    toolCall,
    toolResult,
    isStreaming = false,
    assistantTimestamp,
    toolTimestamp,
}: ToolViewProps) {
    if (!toolCall) {
      return null;
    }

    const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
    const toolMetadata = getToolMetadata(name, toolCall.arguments);
    const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

    const {
        presentationName,
        filePath,
        downloadUrl,
        totalSlides,
        storedLocally,
        message,
        note,
        success,
        format,
    } = extractExportData({ toolCall, toolResult });

    const FormatIcon = format === 'pdf' ? FileText : Presentation;
    const formatLabel = format.toUpperCase();

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
                rightContent: <StatusBadge variant="streaming" label="Exporting" />,
              }}
            >
              <View className="flex-1 w-full">
                <LoadingState
                  icon={toolMetadata.icon}
                  iconColor={toolMetadata.iconColor}
                  bgColor={toolMetadata.iconBgColor}
                  title={`Exporting to ${formatLabel}`}
                  filePath={presentationName || undefined}
                  showProgress={false}
                />
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
                label={actualIsSuccess ? `Exported ${formatLabel}` : 'Failed'}
              />
            ),
          }}
          footer={
            <View className="flex-row items-center justify-between w-full">
              {presentationName && (
                <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
                  {presentationName}
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
                {/* Success/Error Status */}
                <View className="pt-3 items-center">
                    <View className={`${success ? 'bg-primary/10' : 'bg-destructive/10'} rounded-2xl items-center justify-center mb-4`} style={{ width: 64, height: 64 }}>
                        <Icon
                            as={FormatIcon}
                            size={32}
                            className={success ? 'text-primary' : 'text-destructive'}
                        />
                    </View>
                    <Text className="text-base font-roobert-medium text-foreground mb-1">
                        {success ? `Exported to ${formatLabel}` : 'Export Failed'}
                    </Text>
                    {presentationName && (
                        <Text className="text-sm font-roobert text-muted-foreground">
                            {presentationName}
                        </Text>
                    )}
                </View>

                {/* Export Details */}
                {success && (presentationName || totalSlides !== undefined) && (
                    <View className="bg-card border border-border rounded-xl p-4 gap-3">
                        <View className="flex-row items-center gap-2 mb-2">
                            <Icon as={FormatIcon} size={16} className="text-muted-foreground" />
                            <Text className="text-sm font-roobert-medium text-foreground">
                                Export Details
                            </Text>
                        </View>

                        {presentationName && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Presentation
                                </Text>
                                <Text className="text-sm font-roobert text-foreground">
                                    {presentationName}
                                </Text>
                            </View>
                        )}

                        {totalSlides !== undefined && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Slides
                                </Text>
                                <View className="flex-row items-center gap-1.5">
                                    <Icon as={Layers} size={14} className="text-foreground/60" />
                                    <Text className="text-sm font-roobert text-foreground">
                                        {totalSlides} slide{totalSlides !== 1 ? 's' : ''}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {storedLocally !== undefined && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Storage
                                </Text>
                                <Text className="text-sm font-roobert text-foreground">
                                    {storedLocally ? 'Stored locally' : 'Temporary'}
                                </Text>
                            </View>
                        )}

                        {downloadUrl && (
                            <View className="gap-1">
                                <Text className="text-xs font-roobert-medium text-muted-foreground">
                                    Download Path
                                </Text>
                                <Text className="text-xs font-roobert-mono text-foreground/60" selectable>
                                    {downloadUrl}
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Download Note for Mobile */}
                {success && storedLocally && (
                    <View className="bg-card border border-border rounded-2xl p-4">
                        <View className="flex-row items-start gap-3">
                            <View className="bg-primary/10 rounded-full p-2">
                                <Icon as={Download} size={16} className="text-primary" />
                            </View>
                            <Text className="text-sm font-roobert text-foreground/80 flex-1">
                                The {formatLabel} file is stored in the workspace and can be accessed via the web interface for download.
                            </Text>
                        </View>
                    </View>
                )}
            </View>
          </ScrollView>
        </ToolViewCard>
    );
}
