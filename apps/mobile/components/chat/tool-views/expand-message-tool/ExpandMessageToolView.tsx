import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Maximize2, CheckCircle2, AlertCircle } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractExpandMessageData } from './_utils';

export function ExpandMessageToolView({ toolData, isStreaming = false }: ToolViewProps) {
  const { expanded_content, success } = extractExpandMessageData(toolData);

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-purple-500/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={Maximize2} size={40} className="text-purple-500 animate-pulse" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Expanding Message
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <View className="px-6 py-4 gap-6">
        <View className="flex-row items-center gap-3">
          <View className="bg-purple-500/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
            <Icon as={Maximize2} size={24} className="text-purple-500" />
          </View>
          <View className="flex-1">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
              Expand Message
            </Text>
            <Text className="text-xl font-roobert-semibold text-foreground">
              Expanded
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

        {expanded_content ? (
          <View className="bg-muted/10 dark:bg-muted/80 rounded-xl p-4 border border-border">
            <Text className="text-sm font-roobert text-foreground leading-6" selectable>
              {expanded_content}
            </Text>
          </View>
        ) : (
          <View className="py-8 items-center">
            <View className="bg-muted/30 rounded-2xl items-center justify-center mb-4" style={{ width: 64, height: 64 }}>
              <Icon as={Maximize2} size={32} className="text-muted-foreground" />
            </View>
            <Text className="text-base font-roobert-medium text-foreground mb-1">
              No Content
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              No expanded content available
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

