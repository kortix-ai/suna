import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FileDiff, Minus, Plus, ChevronDown, ChevronUp } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractStrReplaceData, generateLineDiff, calculateDiffStats } from './_utils';
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

export function StrReplaceToolView({ toolCall, toolResult, isStreaming, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { filePath, oldStr, newStr, success } = extractStrReplaceData({ toolCall, toolResult });
  const [expanded, setExpanded] = useState(true);

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const lineDiff = oldStr && newStr ? generateLineDiff(oldStr, newStr) : [];
  const stats = calculateDiffStats(lineDiff);

  const toggleExpanded = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded(!expanded);
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
          rightContent: <StatusBadge variant="streaming" label="Processing" />,
        }}
      >
        <View className="flex-1 w-full">
          <LoadingState
            icon={toolMetadata.icon}
            iconColor={toolMetadata.iconColor}
            bgColor={toolMetadata.iconBgColor}
            title="Processing Replacement"
            subtitle="Analyzing text patterns"
            filePath={filePath || undefined}
            showProgress={false}
          />
        </View>
      </ToolViewCard>
    );
  }

  if (!oldStr || !newStr) {
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
            <Icon as={FileDiff} size={40} className="text-destructive" />
          </View>
          <Text className="text-xl font-roobert-semibold mb-2 text-foreground">
            Invalid Replacement
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            Could not extract strings from request
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
          <View className="flex-row items-center gap-2">
            <View className="flex-row items-center gap-1">
              <Icon as={Plus} size={12} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-foreground">
                {stats.additions}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Icon as={Minus} size={12} className="text-destructive" />
              <Text className="text-xs font-roobert-medium text-foreground">
                {stats.deletions}
              </Text>
            </View>
          </View>
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {filePath && (
            <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
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
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                File
              </Text>
            </View>
            <View className="bg-card border border-border rounded-2xl p-4">
              <Text className="text-sm font-roobert text-foreground" selectable>
                {filePath || 'Unknown file'}
              </Text>
            </View>
          </View>

          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Changes
              </Text>
              <Pressable
                onPress={toggleExpanded}
                className="flex-row items-center gap-1.5 bg-muted active:bg-muted/80 px-3 py-1.5 rounded-full"
              >
                <Icon
                  as={expanded ? ChevronUp : ChevronDown}
                  size={14}
                  className="text-foreground/60"
                />
                <Text className="text-xs font-roobert-medium text-foreground/60">
                  {expanded ? 'Collapse' : 'Expand'}
                </Text>
              </Pressable>
            </View>

            <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ maxHeight: expanded ? 400 : 160 }}>
              <ScrollView showsVerticalScrollIndicator={false}>
                {lineDiff.map((line, idx) => {
                  if (line.type === 'unchanged') return null;

                  return (
                    <View
                      key={idx}
                      className={`flex-row items-start gap-2 px-4 py-1.5 ${line.type === 'added'
                        ? 'bg-primary/5'
                        : 'bg-destructive/5'
                        }`}
                    >
                      <Icon
                        as={line.type === 'added' ? Plus : Minus}
                        size={14}
                        className={line.type === 'added' ? 'text-primary mt-0.5' : 'text-destructive mt-0.5'}
                      />
                      <Text
                        className={`text-xs font-roobert flex-1 ${line.type === 'added'
                          ? 'text-primary'
                          : 'text-destructive'
                          }`}
                        selectable
                      >
                        {line.type === 'added' ? line.newLine : line.oldLine}
                      </Text>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
