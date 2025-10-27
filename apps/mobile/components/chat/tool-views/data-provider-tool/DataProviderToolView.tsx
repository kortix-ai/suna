import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Network, CheckCircle2, AlertCircle, ExternalLink, List } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractDataProviderData } from './_utils';

export function DataProviderToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { provider, endpoint, method, response, endpoints, success } = extractDataProviderData(toolData);
  
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
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={isEndpointsList ? List : Network} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              {isEndpointsList ? 'Data Provider Endpoints' : 'Data Provider Call'}
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {provider || 'API'}
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
            success ? 'bg-primary/10' : 'bg-destructive/10'
          }`}>
            <Icon 
              as={success ? CheckCircle2 : AlertCircle} 
              size={12} 
              className={success ? 'text-primary' : 'text-destructive'} 
            />
            <Text className={`text-xs font-roobert-medium ${
              success ? 'text-primary' : 'text-destructive'
            }`}>
              {success ? 'Success' : 'Failed'}
            </Text>
          </View>
        </View>

        {endpoint && (
          <View className="bg-muted/50 rounded-xl p-3 border border-border">
            <View className="flex-row items-center gap-2 mb-1">
              <Icon as={ExternalLink} size={14} className="text-muted-foreground" />
              <Text className="text-xs font-roobert-medium text-muted-foreground">Endpoint</Text>
            </View>
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {method && <Text className="text-primary">{method} </Text>}
              {endpoint}
            </Text>
          </View>
        )}

        {isEndpointsList ? (
          <View className="gap-3">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Available Endpoints ({endpoints.length})
            </Text>
            <View className="gap-2">
              {endpoints.map((ep, idx) => {
                const epName = typeof ep === 'string' ? ep : ep.name || ep.endpoint;
                const epMethod = typeof ep === 'object' && ep.method ? ep.method : null;
                
                return (
                  <View 
                    key={idx}
                    className="bg-card border border-border rounded-xl p-3"
                  >
                    <View className="flex-row items-center gap-2">
                      {epMethod && (
                        <View className="bg-primary/10 px-2 py-0.5 rounded">
                          <Text className="text-xs font-roobert-mono text-primary">
                            {epMethod}
                          </Text>
                        </View>
                      )}
                      <Text className="text-sm font-roobert-mono text-foreground flex-1" numberOfLines={2}>
                        {epName}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        ) : responseString ? (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Response
            </Text>
            <View className="bg-zinc-900 dark:bg-zinc-950 rounded-xl overflow-hidden border border-zinc-700 dark:border-zinc-800">
              <View className="bg-zinc-800 dark:bg-zinc-900 px-3 py-2 border-b border-zinc-700 dark:border-zinc-800">
                <Text className="text-xs font-roobert-medium text-zinc-300">JSON</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View className="p-3">
                  <Text 
                    className="text-xs font-roobert-mono text-zinc-300 leading-5"
                    selectable
                  >
                    {responseString}
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        ) : (
          <View className="py-8 items-center">
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
  );
}

