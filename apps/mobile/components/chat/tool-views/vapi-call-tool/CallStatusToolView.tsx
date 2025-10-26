import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Phone, Clock, DollarSign, User, Bot } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCallStatusData, formatPhoneNumber, formatDuration, statusConfig } from './_utils';

export function CallStatusToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const data = extractCallStatusData(toolData);
  
  const statusInfo = statusConfig[data.status as keyof typeof statusConfig] || statusConfig.queued;

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Phone} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Fetching Call Status
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
              Call Status
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              {formatPhoneNumber(data.phone_number)}
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${statusInfo.bg}`}>
            <Text className={`text-xs font-roobert-medium ${statusInfo.color}`}>
              {statusInfo.label}
            </Text>
          </View>
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

        {data.transcript && data.transcript.length > 0 && (
          <View className="gap-3">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Transcript ({data.transcript.length} messages)
            </Text>
            <View className="gap-2">
              {data.transcript.map((msg, idx) => (
                <View
                  key={idx}
                  className={`rounded-xl p-3 ${
                    msg.role === 'assistant' 
                      ? 'bg-primary/10 ml-4' 
                      : 'bg-muted/50 mr-4'
                  }`}
                >
                  <View className="flex-row items-center gap-2 mb-1">
                    <Icon 
                      as={msg.role === 'assistant' ? Bot : User} 
                      size={12} 
                      className="text-muted-foreground" 
                    />
                    <Text className="text-xs font-roobert-medium text-muted-foreground">
                      {msg.role === 'assistant' ? 'AI' : 'Caller'}
                    </Text>
                  </View>
                  <Text className="text-sm font-roobert text-foreground">
                    {msg.message}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

