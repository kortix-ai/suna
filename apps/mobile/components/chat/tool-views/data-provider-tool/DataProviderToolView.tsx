import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Network } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState, JsonViewer } from '../shared';
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

export function DataProviderToolView({ toolCall, toolResult, isStreaming = false, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  const { provider, endpoint, method, response, endpoints, success } = extractDataProviderData({ toolCall, toolResult });

  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : (success !== false);

  const isEndpointsList = endpoints.length > 0;
  const responseString = response
    ? JSON.stringify(response, null, 2)
    : null;

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
            title={isEndpointsList ? 'Fetching Endpoints' : 'Calling API'}
            filePath={provider || undefined}
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
        showStatus: true,
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {endpoint && (
            <Text className="text-xs text-muted-foreground flex-1 font-roobert-mono" numberOfLines={1}>
              {method && `${method} `}{endpoint}
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
          {endpoint && (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Endpoint
              </Text>
              <View className="bg-card border border-border rounded-2xl p-4">
                <Text className="text-sm font-roobert-mono text-foreground" selectable>
                  {method && <Text className="text-primary">{method} </Text>}
                  {endpoint}
                </Text>
              </View>
            </View>
          )}

          {isEndpointsList ? (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Available Endpoints ({endpoints.length})
              </Text>
              <View className="gap-2">
                {endpoints.map((ep, idx) => {
                  const epName = typeof ep === 'string' ? ep : ep.name || ep.endpoint;
                  const epMethod = typeof ep === 'object' && ep.method ? ep.method : null;

                  return (
                    <View
                      key={idx}
                      className="bg-card border border-border rounded-2xl p-4"
                    >
                      <Text className="text-sm font-roobert-mono text-foreground" selectable>
                        {epMethod && <Text className="text-primary">{epMethod} </Text>}
                        {epName}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : responseString ? (
            <View className="gap-2">
              <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                Response
              </Text>
              <JsonViewer data={response} title="RESPONSE" defaultExpanded={true} />
            </View>
          ) : (
            <View className="py-12 items-center">
              <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
                <Icon as={Network} size={32} className="text-muted-foreground" />
              </View>
              <Text className="text-base font-roobert-medium text-foreground mb-1">
                No Response
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                No data returned from API
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </ToolViewCard>
  );
}
