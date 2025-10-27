import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Phone, Clock, Calendar } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractListCallsData, formatPhoneNumber, formatDuration, statusConfig } from './_utils';

export function ListCallsToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const data = extractListCallsData(toolData);

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Phone} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Fetching Calls
        </Text>
      </View>
    );
  }

  if (data.calls.length === 0) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 80, height: 80 }}>
          <Icon as={Phone} size={40} className="text-muted-foreground" />
        </View>
        <Text className="text-lg font-roobert-semibold text-foreground mb-2">
          No Calls Found
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          No call history available
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Phone} size={24} className="text-blue-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Call History
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {data.count} {data.count === 1 ? 'Call' : 'Calls'}
            </Text>
          </View>
        </View>

        <View className="gap-3">
          {data.calls.map((call, idx) => {
            const statusInfo = statusConfig[call.status as keyof typeof statusConfig] || statusConfig.queued;
            
            return (
              <View key={call.call_id || idx} className="bg-card border border-border rounded-xl p-4 gap-3">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-roobert-semibold text-foreground">
                    {formatPhoneNumber(call.phone_number)}
                  </Text>
                  <View className={`px-2 py-1 rounded-full ${statusInfo.bg}`}>
                    <Text className={`text-xs font-roobert-medium ${statusInfo.color}`}>
                      {statusInfo.label}
                    </Text>
                  </View>
                </View>

                <View className="flex-row flex-wrap gap-2">
                  {call.duration_seconds !== undefined && (
                    <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                      <Icon as={Clock} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {formatDuration(call.duration_seconds)}
                      </Text>
                    </View>
                  )}
                  
                  {call.started_at && (
                    <View className="flex-row items-center gap-1.5 bg-muted/30 px-2 py-1 rounded">
                      <Icon as={Calendar} size={12} className="text-muted-foreground" />
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {new Date(call.started_at).toLocaleString()}
                      </Text>
                    </View>
                  )}
                </View>

                <View className="bg-muted/20 p-2 rounded">
                  <Text className="text-xs font-roobert-mono text-muted-foreground" selectable>
                    {call.call_id}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

