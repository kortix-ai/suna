import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
    Database,
    Globe
} from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderEndpointsData } from './_utils';
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

export function DataProviderEndpointsToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
    if (!toolCall) {
      return null;
    }

    const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
    const toolMetadata = getToolMetadata(name, toolCall.arguments);
    const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

    const { serviceName, endpoints, success } = extractDataProviderEndpointsData({ toolCall, toolResult });

    const endpointCount = endpoints && typeof endpoints === 'object' ? Object.keys(endpoints).length : 0;

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
                  title="Loading Provider"
                  subtitle="Connecting to data source..."
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
                label={endpointCount > 0 ? `${endpointCount} endpoints` : actualIsSuccess ? 'Ready' : 'Failed'}
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
                {/* Provider Name */}
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

                {/* Endpoints Count */}
                {endpointCount > 0 && (
                    <View className="gap-2">
                        <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                            Endpoints
                        </Text>
                        <View className="bg-card border border-border rounded-2xl p-4">
                            <Text className="text-sm font-roobert text-foreground">
                                {endpointCount} endpoint{endpointCount !== 1 ? 's' : ''} loaded
                            </Text>
                        </View>
                    </View>
                )}
            </View>
          </ScrollView>
        </ToolViewCard>
    );
}
