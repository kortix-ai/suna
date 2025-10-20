/**
 * Generic Tool View
 * 
 * Default fallback view for tools without specialized renderers
 */

import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, AlertCircle, Wrench } from 'lucide-react-native';
import type { ToolViewProps } from './types';

export function GenericToolView({ toolData }: ToolViewProps) {
  const { toolName, arguments: toolArgs, result } = toolData;
  const isError = !result.success;

  return (
    <View className="px-6 py-4 gap-6">
      {/* Header */}
      <View className="flex-row items-center gap-3">
        <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
          <Icon as={Wrench} size={24} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            Tool Execution
          </Text>
          <Text className="text-xl font-roobert-semibold text-foreground">
            {toolName}
          </Text>
        </View>
      </View>

      {/* Parameters */}
      {Object.keys(toolArgs).length > 0 && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Parameters
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text className="text-sm font-roobert text-foreground/80" selectable>
                {JSON.stringify(toolArgs, null, 2)}
              </Text>
            </ScrollView>
          </View>
        </View>
      )}

      {/* Result */}
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Result
          </Text>
          <View className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-full ${
            isError ? 'bg-destructive/10' : 'bg-primary/10'
          }`}>
            <Icon 
              as={isError ? AlertCircle : CheckCircle2} 
              size={12} 
              className={isError ? 'text-destructive' : 'text-primary'} 
            />
            <Text className={`text-xs font-roobert-medium ${
              isError ? 'text-destructive' : 'text-primary'
            }`}>
              {isError ? 'Failed' : 'Success'}
            </Text>
          </View>
        </View>
        
        <View className={`rounded-2xl p-4 border ${
          isError 
            ? 'bg-destructive/5 border-destructive/20' 
            : 'bg-primary/5 border-primary/20'
        }`}>
          {result.output ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text className="text-sm font-roobert text-foreground/80" selectable>
                {typeof result.output === 'string' 
                  ? result.output 
                  : JSON.stringify(result.output, null, 2)}
              </Text>
            </ScrollView>
          ) : (
            <Text className="text-sm font-roobert text-foreground/40 italic">
              No output
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

