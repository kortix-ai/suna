import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, CheckCircle2, AlertCircle, DollarSign, Hash } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWaitForCallCompletionData, formatDuration, statusConfig } from './_utils';

export function WaitForCallCompletionToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const data = extractWaitForCallCompletionData(toolData);
  
  const statusInfo = statusConfig[data.final_status as keyof typeof statusConfig] || statusConfig.completed;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-amber-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Clock} size={40} className="text-amber-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Waiting for Call
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Monitoring call completion...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-amber-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Clock} size={24} className="text-amber-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Call Completion
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              Completed
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

        <View className="flex-row gap-2">
          {data.duration_seconds !== undefined && (
            <View className="bg-muted/30 rounded-xl p-3 border border-border flex-1">
              <View className="flex-row items-center gap-2 mb-1">
                <Icon as={Clock} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert-medium text-muted-foreground">Duration</Text>
              </View>
              <Text className="text-lg font-roobert-semibold text-foreground">
                {formatDuration(data.duration_seconds)}
              </Text>
            </View>
          )}
          
          {data.cost !== undefined && (
            <View className="bg-muted/30 rounded-xl p-3 border border-border flex-1">
              <View className="flex-row items-center gap-2 mb-1">
                <Icon as={DollarSign} size={14} className="text-muted-foreground" />
                <Text className="text-xs font-roobert-medium text-muted-foreground">Cost</Text>
              </View>
              <Text className="text-lg font-roobert-semibold text-foreground">
                ${data.cost.toFixed(2)}
              </Text>
            </View>
          )}
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

