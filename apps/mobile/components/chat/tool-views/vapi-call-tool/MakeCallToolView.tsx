import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Phone, CheckCircle2, AlertCircle, Clock, User } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractMakeCallData, formatPhoneNumber, statusConfig } from './_utils';

export function MakeCallToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  const data = extractMakeCallData({ toolCall, toolResult });

  const status = data.status;
  const statusInfo = statusConfig[status as keyof typeof statusConfig] || statusConfig.queued;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Phone} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Initiating Call
        </Text>
        {data.phone_number && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert-mono text-foreground/60 text-center">
              {formatPhoneNumber(data.phone_number)}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 gap-6">
        <View className="bg-card border border-border rounded-xl p-4 gap-3">
          <View className="flex-row items-center gap-2">
            <Icon as={User} size={16} className="text-muted-foreground" />
            <Text className="text-sm font-roobert-medium text-muted-foreground">
              Call ID
            </Text>
          </View>
          <Text className="text-sm font-roobert-mono text-foreground" selectable>
            {data.call_id}
          </Text>
        </View>

        {data.first_message && (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              First Message
            </Text>
            <View className="bg-muted/10 dark:bg-muted/80 rounded-xl p-4 border border-border">
              <Text className="text-sm font-roobert text-foreground" selectable>
                {data.first_message}
              </Text>
            </View>
          </View>
        )}

        {data.message && (
          <View className={`rounded-xl p-4 border ${status === 'failed' ? 'bg-red-500/10 border-red-500/20' : 'bg-muted/50 border-border'
            }`}>
            <Text className={`text-sm font-roobert ${status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-foreground'
              }`}>
              {data.message}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

