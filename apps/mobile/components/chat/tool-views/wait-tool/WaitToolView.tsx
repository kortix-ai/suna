import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Clock, CheckCircle2, AlertCircle, Timer } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractWaitData, formatDuration } from './_utils';

export function WaitToolView({ toolCall, toolResult, isStreaming }: ToolViewProps) {
  const { seconds, success } = extractWaitData({ toolCall, toolResult });

  return (
    <View className="flex-1 px-6 gap-6">
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

