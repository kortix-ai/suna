import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Bot, CheckCircle2, AlertCircle, Settings, Calendar, Clock } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractAgentData } from './_utils';

export function AgentToolView({ toolCall, toolResult, isStreaming = false }: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const data = extractAgentData(toolCall, toolResult);
  
  const toolName = toolCall.function_name.replace(/_/g, '-');
  const isCreate = toolName.includes('create');
  const isUpdate = toolName.includes('update');
  const isTrigger = toolName.includes('trigger');
  const isList = toolName.includes('list');

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Bot} size={40} className="text-primary animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          {isCreate ? 'Creating Agent' : isUpdate ? 'Updating Agent' : isTrigger ? 'Managing Trigger' : 'Processing'}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={isTrigger ? Clock : Bot} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              {isCreate ? 'Create Agent' : isUpdate ? 'Update Agent' : isTrigger ? 'Trigger Management' : 'Agent'}
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground" numberOfLines={1}>
              {data.agent_name || 'Agent'}
            </Text>
          </View>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
            data.success ? 'bg-primary/10' : 'bg-destructive/10'
          }`}>
            <Icon 
              as={data.success ? CheckCircle2 : AlertCircle} 
              size={12} 
              className={data.success ? 'text-primary' : 'text-destructive'} 
            />
            <Text className={`text-xs font-roobert-medium ${
              data.success ? 'text-primary' : 'text-destructive'
            }`}>
              {data.success ? 'Success' : 'Failed'}
            </Text>
          </View>
        </View>

        {data.message && (
          <View className="bg-muted/50 rounded-xl p-4 border border-border">
            <Text className="text-sm font-roobert text-foreground">
              {data.message}
            </Text>
          </View>
        )}

        {data.agent_id && (
          <View className="bg-card border border-border rounded-xl p-4 gap-2">
            <View className="flex-row items-center gap-2">
              <Icon as={Bot} size={14} className="text-muted-foreground" />
              <Text className="text-xs font-roobert-medium text-muted-foreground">
                Agent ID
              </Text>
            </View>
            <Text className="text-sm font-roobert-mono text-foreground" selectable>
              {data.agent_id}
            </Text>
          </View>
        )}

        {data.config && (
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Icon as={Settings} size={14} className="text-muted-foreground" />
              <Text className="text-sm font-roobert-medium text-foreground/70">
                Configuration
              </Text>
            </View>
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
                    {JSON.stringify(data.config, null, 2)}
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        )}

        {data.trigger && (
          <View className="bg-card border border-border rounded-xl p-4 gap-3">
            <View className="flex-row items-center gap-2">
              <Icon as={Calendar} size={16} className="text-primary" />
              <Text className="text-base font-roobert-semibold text-foreground">
                {data.trigger.name || 'Trigger'}
              </Text>
            </View>
            {data.trigger.schedule && (
              <View className="bg-muted/20 p-2 rounded">
                <Text className="text-xs font-roobert-mono text-muted-foreground">
                  {data.trigger.schedule}
                </Text>
              </View>
            )}
          </View>
        )}

        {data.triggers && data.triggers.length > 0 && (
          <View className="gap-3">
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Triggers ({data.triggers.length})
            </Text>
            {data.triggers.map((trigger: any, idx: number) => (
              <View key={idx} className="bg-card border border-border rounded-xl p-3 gap-2">
                <Text className="text-sm font-roobert-semibold text-foreground">
                  {trigger.name || `Trigger ${idx + 1}`}
                </Text>
                {trigger.schedule && (
                  <View className="flex-row items-center gap-2 bg-muted/20 p-2 rounded">
                    <Icon as={Clock} size={12} className="text-muted-foreground" />
                    <Text className="text-xs font-roobert-mono text-muted-foreground flex-1">
                      {trigger.schedule}
                    </Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

