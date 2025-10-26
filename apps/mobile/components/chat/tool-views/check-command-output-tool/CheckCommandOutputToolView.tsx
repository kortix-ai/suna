import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Terminal, CheckCircle2, AlertCircle, Clock } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractCheckCommandOutputData } from './_utils';

export function CheckCommandOutputToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { sessionName, output, status, success } = extractCheckCommandOutputData(toolData);
  
  const lines = output ? output.split('\n') : [];
  const isSessionRunning = status?.includes('running');

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-blue-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Terminal} size={40} className="text-blue-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Checking Output
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
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-blue-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Terminal} size={24} className="text-blue-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Command Output
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {sessionName || 'Session'}
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

        {status && (
          <View className="bg-muted/50 rounded-xl p-3 border border-border">
            <View className="flex-row items-center gap-2">
              <Icon as={Clock} size={14} className="text-muted-foreground" />
              <Text className="text-xs font-roobert text-muted-foreground">
                Status: <Text className="text-foreground font-roobert-medium">{status}</Text>
              </Text>
            </View>
          </View>
        )}

        {output ? (
          <View className="bg-zinc-900 dark:bg-zinc-950 rounded-xl overflow-hidden border border-zinc-700 dark:border-zinc-800">
            <View className="bg-zinc-800 dark:bg-zinc-900 px-3 py-2 border-b border-zinc-700 dark:border-zinc-800">
              <Text className="text-xs font-roobert-medium text-zinc-300">Output</Text>
            </View>
            <View className="p-3">
              {lines.map((line, idx) => (
                <Text 
                  key={idx}
                  className="text-xs font-roobert-mono text-zinc-300 leading-5"
                  selectable
                >
                  {line || ' '}
                </Text>
              ))}
            </View>
          </View>
        ) : (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={Terminal} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              No Output
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              No output received from session
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

