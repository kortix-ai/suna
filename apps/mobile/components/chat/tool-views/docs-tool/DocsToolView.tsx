import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileText, Calendar } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDocsData, getActionTitle, stripHtmlTags } from './_utils';
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

export function DocsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const data = extractDocsData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

  const toolName = toolCall?.function_name || 'docs';
  const actionTitle = getActionTitle(toolName);

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
          rightContent: <StatusBadge variant="streaming" label="Processing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Processing Document"
            subtitle={`${actionTitle}...`}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (data.error) {
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
              {data.error}
            </Text>
          </View>
        </View>
      </ToolViewCard>
    );
  }

  const document = data.document;
  const documents = data.documents;

  if (documents && documents.length > 0) {
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
            <Text className="text-xs text-muted-foreground">
              {documents.length} {documents.length === 1 ? 'document' : 'documents'} found
            </Text>
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
              {documents.map((doc, idx) => (
                <View key={idx} className="bg-card border border-border rounded-xl p-4">
                  <Text className="text-base font-roobert-semibold text-foreground mb-2">
                    {doc.title}
                  </Text>
                  <View className="flex-row flex-wrap gap-2">
                    <View className="bg-muted/50 px-2 py-1 rounded-lg">
                      <Text className="text-xs font-roobert-mono text-muted-foreground uppercase">
                        {doc.format}
                      </Text>
                    </View>
                    {doc.created_at && (
                      <View className="bg-muted/50 px-2 py-1 rounded-lg flex-row items-center gap-1">
                        <Icon as={Calendar} size={10} className="text-muted-foreground" />
                        <Text className="text-xs font-roobert text-muted-foreground">
                          {new Date(doc.created_at).toLocaleDateString()}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </ToolViewCard>
    );
  }

  if (document) {
    const content = data.content || document.content || '';
    const displayContent = stripHtmlTags(content);
    const contentLines = displayContent.split('\n').filter(line => line.trim());

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
            {document.title && (
              <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
                {document.title}
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
            {contentLines.length > 0 && (
              <View className="gap-2">
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  Content
                </Text>
                <View className="bg-muted/10 dark:bg-muted/80 rounded-xl p-4 border border-border">
                  {contentLines.map((line, idx) => (
                    <Text
                      key={idx}
                      className="text-sm font-roobert text-foreground leading-6 mb-2"
                      selectable
                    >
                      {line}
                    </Text>
                  ))}
                </View>
              </View>
            )}

            {document.metadata?.tags && document.metadata.tags.length > 0 && (
              <View className="gap-2">
                <Text className="text-sm font-roobert-medium text-foreground/70">
                  Tags
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {document.metadata.tags.map((tag, idx) => (
                    <View key={idx} className="bg-primary/10 px-3 py-1.5 rounded-full">
                      <Text className="text-xs font-roobert-medium text-primary">
                        {tag}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      </ToolViewCard>
    );
  }

  if (data.message) {
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
              label="Completed"
            />
          ),
        }}
      >
        <View className="flex-1 w-full px-4 py-4">
          <View className="bg-primary/10 rounded-xl p-4 border border-primary/20">
            <Text className="text-sm font-roobert text-foreground">
              {data.message}
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
        rightContent: <StatusBadge variant="success" label="Completed" />,
      }}
    >
      <View className="flex-1 w-full items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={FileText} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          No Document Data
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          No document information available
        </Text>
      </View>
    </ToolViewCard>
  );
}
