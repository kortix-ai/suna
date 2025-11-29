import React, { useState } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { FileDiff, CheckCircle2, AlertCircle, File, Minus, Plus, ChevronDown, ChevronUp } from 'lucide-react-native';
import type { ToolViewProps } from '../types';
import { extractStrReplaceData, generateLineDiff, calculateDiffStats } from './_utils';
import * as Haptics from 'expo-haptics';

export function StrReplaceToolView({ toolCall, toolResult, isStreaming }: ToolViewProps) {
  const { filePath, oldStr, newStr, success } = extractStrReplaceData({ toolCall, toolResult });
  const [expanded, setExpanded] = useState(true);

  const lineDiff = oldStr && newStr ? generateLineDiff(oldStr, newStr) : [];
  const stats = calculateDiffStats(lineDiff);

  const toggleExpanded = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setExpanded(!expanded);
  };

  if (isStreaming) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-primary/10 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <ActivityIndicator size="large" color="#0066FF" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Processing Replacement
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Analyzing text patterns
        </Text>
        {filePath && (
          <View className="bg-card border border-border rounded-2xl px-4 py-3 mt-3 w-full">
            <Text className="text-xs font-roobert-medium text-foreground/60 text-center" numberOfLines={1}>
              {filePath}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (!oldStr || !newStr) {
    return (
      <View className="flex-1 items-center justify-center py-12 px-6">
        <View className="bg-muted/30 rounded-2xl items-center justify-center mb-6" style={{ width: 80, height: 80 }}>
          <Icon as={AlertCircle} size={40} className="text-destructive" />
        </View>
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Invalid Replacement
        </Text>
        <Text className="text-sm font-roobert text-muted-foreground text-center">
          Could not extract strings from request
        </Text>
      </View>
    );
  }

  return (
    <View className="px-6 gap-6">
      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
              File
            </Text>
          </View>
          <View className="flex-row items-center gap-3">
            <View className="flex-row items-center gap-1">
              <Icon as={Plus} size={14} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-foreground/60">
                {stats.additions}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Icon as={Minus} size={14} className="text-destructive" />
              <Text className="text-xs font-roobert-medium text-foreground/60">
                {stats.deletions}
              </Text>
            </View>
          </View>
        </View>
        <View className="bg-card border border-border rounded-2xl p-4">
          <Text className="text-sm font-roobert text-foreground" selectable>
            {filePath || 'Unknown file'}
          </Text>
        </View>
      </View>

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Changes
          </Text>
          <Pressable
            onPress={toggleExpanded}
            className="flex-row items-center gap-1.5 bg-secondary active:bg-secondary/80 px-3 py-1.5 rounded-full"
          >
            <Icon
              as={expanded ? ChevronUp : ChevronDown}
              size={14}
              className="text-foreground/60"
            />
            <Text className="text-xs font-roobert-medium text-foreground/60">
              {expanded ? 'Collapse' : 'Expand'}
            </Text>
          </Pressable>
        </View>

        <View className="bg-card border border-border rounded-2xl overflow-hidden" style={{ maxHeight: expanded ? 400 : 160 }}>
          <ScrollView showsVerticalScrollIndicator={false}>
            {lineDiff.map((line, idx) => {
              if (line.type === 'unchanged') return null;

              return (
                <View
                  key={idx}
                  className={`flex-row items-start gap-2 px-4 py-1.5 ${line.type === 'added'
                    ? 'bg-primary/5'
                    : 'bg-destructive/5'
                    }`}
                >
                  <Icon
                    as={line.type === 'added' ? Plus : Minus}
                    size={14}
                    className={line.type === 'added' ? 'text-primary mt-0.5' : 'text-destructive mt-0.5'}
                  />
                  <Text
                    className={`text-xs font-roobert flex-1 ${line.type === 'added'
                      ? 'text-primary'
                      : 'text-destructive'
                      }`}
                    selectable
                  >
                    {line.type === 'added' ? line.newLine : line.oldLine}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

