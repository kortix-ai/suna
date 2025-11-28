import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { PhoneOff, CheckCircle2, AlertCircle } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractEndCallData, statusConfig } from './_utils';

export function EndCallToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  const data = extractEndCallData({ toolCall, toolResult });

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
      <View className="px-6 gap-6">
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

