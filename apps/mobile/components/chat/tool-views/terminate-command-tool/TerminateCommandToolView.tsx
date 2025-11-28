import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { StopCircle, CheckCircle2, AlertCircle, Terminal, Power } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractTerminateCommandData } from './_utils';

export function TerminateCommandToolView({ toolCall, toolResult, isSuccess = true, isStreaming = false }: ToolViewProps) {
  const { sessionName, output, success } = extractTerminateCommandData(toolCall, toolResult, isSuccess);
  const lines = output ? output.split('\n') : [];

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-red-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={StopCircle} size={40} className="text-red-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Terminating Session
        </Text>
        {sessionName && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3">
            <Text className="text-sm font-roobert-mono text-foreground/60 text-center">
              {sessionName}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 gap-6">
        <View className="bg-card border border-border rounded-2xl p-4">
          <View className="flex-row items-center gap-2 mb-3">
            <Icon as={Power} size={16} className="text-foreground/60" />
            <Text className="text-sm font-roobert-medium text-foreground/70">Session</Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="text-red-500" selectable>●</Text>
            <Text className="text-sm font-roobert-mono text-foreground flex-1" selectable>
              {sessionName || 'Unknown'}
            </Text>
          </View>
        </View>

        {output && (
          <View className="gap-2">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Result
            </Text>
            <View className="rounded-2xl p-4 border bg-card border-border" style={{ maxHeight: 400 }}>
              <ScrollView showsVerticalScrollIndicator={false}>
                {lines.map((line, idx) => (
                  <Text
                    key={idx}
                    className="text-sm font-roobert-mono text-foreground/80 leading-5"
                    selectable
                  >
                    {line || ' '}
                  </Text>
                ))}
              </ScrollView>
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

