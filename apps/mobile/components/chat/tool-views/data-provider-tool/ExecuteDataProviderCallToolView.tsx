import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
    Network,
    ChevronRight,
    ChevronDown,
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderCallData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState, JsonViewer } from '../shared';
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

export function ExecuteDataProviderCallToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
    const [showRawJson, setShowRawJson] = useState(false);

    if (!toolCall) {
      return null;
    }

    const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
    const toolMetadata = getToolMetadata(name, toolCall.arguments);
    const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

    const { serviceName, route, payload, output, success } = extractDataProviderCallData({ toolCall, toolResult });

    const hasPayload = payload && Object.keys(payload).length > 0;

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
                rightContent: <StatusBadge variant="streaming" label="Executing" />,
              }}
            >
              <View className="flex-1 w-full">
                <LoadingState
                  icon={toolMetadata.icon}
                  iconColor={toolMetadata.iconColor}
                  bgColor={toolMetadata.iconBgColor}
                  title="Executing Call"
                  subtitle={`Calling ${serviceName || 'data provider'}...`}
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
                label={actualIsSuccess ? 'Success' : 'Failed'}
              />
            ),
          }}
          footer={
            <View className="flex-row items-center justify-between w-full">
              {serviceName && (
                <Text className="text-xs text-muted-foreground flex-1" numberOfLines={1}>
                  {serviceName}
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
                {/* Provider */}
                {serviceName && (
                  <View className="gap-2">
                      <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                          Provider
                      </Text>
                      <View className="bg-card border border-border rounded-2xl p-4">
                          <Text className="text-base font-roobert-semibold text-foreground">
                              {serviceName}
                          </Text>
                      </View>
                  </View>
                )}

                {/* Route */}
                {route && (
                    <View className="gap-2">
                        <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                            Route
                        </Text>
                        <View className="bg-card border border-border rounded-2xl p-4">
                            <Text className="text-sm font-roobert-mono text-foreground" selectable>
                                {route}
                            </Text>
                        </View>
                    </View>
                )}

                {/* Error Message */}
                {output && !success && (
                    <View className="gap-2">
                        <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                            Error
                        </Text>
                        <View className="bg-card border border-border rounded-2xl p-4">
                            <Text className="text-sm font-roobert text-destructive" selectable>
                                {output}
                            </Text>
                        </View>
                    </View>
                )}

                {/* Call Parameters */}
                {hasPayload && (
                    <View className="gap-2">
                        <View className="flex-row items-center justify-between">
                            <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                                Parameters
                            </Text>
                            <Pressable
                                onPress={() => {
                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  setShowRawJson(!showRawJson);
                                }}
                                className="flex-row items-center gap-1.5 bg-muted active:bg-muted/80 px-3 py-1.5 rounded-full"
                            >
                                <Icon
                                    as={showRawJson ? ChevronDown : ChevronRight}
                                    size={14}
                                    className="text-foreground/60"
                                />
                                <Text className="text-xs font-roobert-medium text-foreground/60">
                                    {showRawJson ? 'Hide JSON' : 'Show JSON'}
                                </Text>
                            </Pressable>
                        </View>

                        {showRawJson ? (
                            <JsonViewer data={payload} title="PARAMETERS" defaultExpanded={true} />
                        ) : (
                            <View className="gap-2">
                                {Object.entries(payload).map(([key, value]) => (
                                    <View
                                        key={key}
                                        className="bg-card border border-border rounded-2xl p-4"
                                    >
                                        <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">
                                            {key}
                                        </Text>
                                        <Text className="text-sm font-roobert text-foreground" selectable>
                                            {typeof value === 'string' ? value : JSON.stringify(value)}
                                        </Text>
                                    </View>
                                ))}
                            </View>
                        )}
                    </View>
                )}
            </View>
          </ScrollView>
        </ToolViewCard>
    );
}
