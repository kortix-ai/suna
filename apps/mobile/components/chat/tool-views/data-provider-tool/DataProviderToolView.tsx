import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Network, CheckCircle2, AlertCircle, ExternalLink, List } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderData } from './_utils';

export function DataProviderToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  const { provider, endpoint, method, response, endpoints, success } = extractDataProviderData({ toolCall, toolResult });

  const isEndpointsList = endpoints.length > 0;
  const responseString = response
    ? JSON.stringify(response, null, 2)
    : null;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Network} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {isEndpointsList ? 'Fetching Endpoints' : 'Calling API'}
        </Text>
        {provider && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert text-foreground/60 text-center">
              {provider}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View className="px-6 gap-6">
      {endpoint && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
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
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
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
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Response
          </Text>
          <View className="bg-card border border-border rounded-2xl" style={{ maxHeight: 400 }}>
            <ScrollView showsVerticalScrollIndicator={false} className="p-4">
              <Text
                className="text-sm font-roobert-mono text-foreground/80 leading-5"
                selectable
              >
                {responseString}
              </Text>
            </ScrollView>
          </View>
        </View>
      ) : (
        <View className="py-12 items-center">
          <View className="bg-background rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
            <Icon as={Network} size={32} className="text-foreground/30" />
          </View>
          <Text className="text-base font-roobert-medium text-foreground mb-1">
            No Response
          </Text>
          <Text className="text-sm font-roobert text-foreground/60 text-center">
            No data returned from API
          </Text>
        </View>
      )}
    </View>
  );
}

