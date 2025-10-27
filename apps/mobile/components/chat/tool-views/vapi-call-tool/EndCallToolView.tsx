import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { PhoneOff, CheckCircle2, AlertCircle } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractEndCallData, statusConfig } from './_utils';

export function EndCallToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const data = extractEndCallData(toolData);
  
  const statusInfo = statusConfig[data.status as keyof typeof statusConfig] || statusConfig.ended;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-red-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={PhoneOff} size={40} className="text-red-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Ending Call
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-red-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={PhoneOff} size={24} className="text-red-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              End Call
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              Call Ended
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${statusInfo.bg}`}>
            <Icon 
              as={CheckCircle2} 
              size={12} 
              className="text-primary" 
            />
            <Text className={`text-xs font-roobert-medium ${statusInfo.color}`}>
              {statusInfo.label}
            </Text>
          </View>
        </View>

        <View className="bg-card border border-border rounded-xl p-4 gap-3">
          <Text className="text-sm font-roobert-medium text-muted-foreground">
            Call ID
          </Text>
          <Text className="text-sm font-roobert-mono text-foreground" selectable>
            {data.call_id}
          </Text>
        </View>

        {data.message && (
          <View className="bg-muted/50 rounded-xl p-4 border border-border">
            <Text className="text-sm font-roobert text-foreground">
              {data.message}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

