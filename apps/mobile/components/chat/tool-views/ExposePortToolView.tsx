/**
 * Expose Port Tool View
 */

import React, { useState } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import {
  ExternalLink,
  Copy,
  Check,
  Clock,
} from 'lucide-react-native';
import type { ToolViewProps } from './types';
import { ToolViewCard, StatusBadge } from './shared';
import { getToolMetadata } from './tool-metadata';
import { log } from '@/lib/logger';

function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

export function ExposePortToolView({ toolCall, toolResult, assistantTimestamp, toolTimestamp }: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolMetadata = getToolMetadata(name, toolCall.arguments);
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : true;

  const toolArgs = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  const [copied, setCopied] = useState(false);
  const isError = !toolResult?.success;

  const port = toolArgs.port;
  const publicUrl = toolResult?.output?.url || toolResult?.output?.public_url || '';

  const handleCopy = async () => {
    if (publicUrl) {
      await Clipboard.setStringAsync(publicUrl);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenUrl = async () => {
    if (publicUrl) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        const canOpen = await Linking.canOpenURL(publicUrl);
        if (canOpen) {
          await Linking.openURL(publicUrl);
        }
      } catch (err) {
        log.error('Failed to open URL:', err);
      }
    }
  };

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: '',
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            iconOnly={true}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          <Text className="text-xs text-primary opacity-50">
            Port {port}
          </Text>
          <View className="flex-row items-center gap-2">
            <Icon as={Clock} size={12} className="text-primary opacity-50" />
            <Text className="text-xs text-primary opacity-50">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          </View>
        </View>
      }
    >
      <View className="flex-1 w-full px-4 py-4">
        {publicUrl && !isError ? (
          <View className="gap-3">
            {/* Gray label */}
            <Text className="text-xs text-muted-foreground">
              Public URL
            </Text>

            {/* Card with URL only */}
            <View className="bg-card border border-border rounded-xl p-3.5">
              <Text className="text-sm font-roobert-mono text-primary" selectable numberOfLines={2}>
                {publicUrl}
              </Text>
            </View>

            {/* Full width buttons */}
            <View className="flex-row gap-2">
              <Pressable
                onPress={handleOpenUrl}
                className="flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-xl bg-primary active:opacity-70"
              >
                <Icon as={ExternalLink} size={15} className="text-primary-foreground" />
                <Text className="text-sm font-roobert-medium text-primary-foreground">Open</Text>
              </Pressable>
              <Pressable
                onPress={handleCopy}
                className="flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-xl border border-border active:opacity-70"
              >
                <Icon as={copied ? Check : Copy} size={15} className="text-primary" />
                <Text className="text-sm font-roobert-medium text-primary">
                  {copied ? 'Copied' : 'Copy'}
                </Text>
              </Pressable>
            </View>

            {/* Info */}
            <Text className="text-xs text-muted-foreground">
              This URL is publicly accessible and will remain active as long as the server is running.
            </Text>
          </View>
        ) : isError ? (
          <View className="gap-3">
            <Text className="text-xs text-muted-foreground">
              Error
            </Text>
            <View className="bg-card border border-border rounded-xl p-3.5">
              <Text className="text-sm text-destructive">
                Failed to expose port {port}
              </Text>
            </View>
          </View>
        ) : (
          <View className="gap-3">
            <Text className="text-xs text-muted-foreground">
              Status
            </Text>
            <View className="bg-card border border-border rounded-xl p-3.5">
              <Text className="text-sm text-primary opacity-50">
                Exposing port {port}...
              </Text>
            </View>
          </View>
        )}
      </View>
    </ToolViewCard>
  );
}
