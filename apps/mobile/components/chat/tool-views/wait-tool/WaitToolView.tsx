import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, CheckCircle2, AlertCircle, Timer } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWaitData, formatDuration } from './_utils';

export function WaitToolView({ toolData, isStreaming }: ToolViewProps) {
  const { seconds, success } = extractWaitData(toolData);

  return (
    <View className="flex-1 px-6 py-4 gap-6">
      <View className="flex-row items-center gap-3">
        <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
          <Icon as={Clock} size={24} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            Wait
          </Text>
          <Text className="text-xl font-roobert-semibold text-foreground">
            {formatDuration(seconds)}
          </Text>
        </View>
        {!isStreaming && (
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
              {success ? 'Done' : 'Failed'}
            </Text>
          </View>
        )}
        {isStreaming && (
          <View className="bg-primary/10 rounded-full px-2.5 py-1 flex-row items-center gap-1.5">
            <ActivityIndicator size="small" color="#0066FF" />
            <Text className="text-xs font-roobert-medium text-primary">
              Waiting
            </Text>
          </View>
        )}
      </View>

      <View className="flex-1 items-center justify-center py-12">
        <View className="bg-muted/10 rounded-2xl items-center justify-center mb-6" style={{ width: 96, height: 96 }}>
          <Icon as={Timer} size={48} className="text-muted-foreground" />
        </View>
        
        <Text className="text-5xl font-roobert-semibold text-foreground mb-3">
          {formatDuration(seconds)}
        </Text>
        
        <Text className="text-sm font-roobert text-muted-foreground text-center max-w-sm mb-4">
          {isStreaming 
            ? 'The system is currently pausing execution for the specified duration.' 
            : `The system paused execution for ${formatDuration(seconds)} as requested.`
          }
        </Text>
        
        {seconds > 0 && (
          <View className="bg-muted/30 rounded-full px-4 py-2">
            <Text className="text-xs font-roobert-medium text-muted-foreground">
              {isStreaming ? 'Please wait...' : 'Wait completed successfully'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

