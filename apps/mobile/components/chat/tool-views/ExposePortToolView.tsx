/**
 * Expose Port Tool View
 * 
 * Specialized view for port exposure operations
 */

import React, { useState } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import {
  Globe,
  ExternalLink,
  Copy,
  Check,
  Share2,
  Network,
} from 'lucide-react-native';
import type { ToolViewProps } from './types';
import { ToolViewCard, StatusBadge } from './shared';
import { getToolMetadata } from './tool-metadata';

// Utility functions
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
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        const canOpen = await Linking.canOpenURL(publicUrl);
        if (canOpen) {
          await Linking.openURL(publicUrl);
        }
      } catch (err) {
        console.error('Failed to open URL:', err);
      }
    }
  };

  return (
    <ToolViewCard
      header={{
        icon: toolMetadata.icon,
        iconColor: toolMetadata.iconColor,
        iconBgColor: toolMetadata.iconBgColor,
        subtitle: toolMetadata.subtitle.toUpperCase(),
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: false,
        rightContent: (
          <StatusBadge
            variant={actualIsSuccess ? 'success' : 'error'}
            label={actualIsSuccess ? 'Exposed' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="flex-row items-center justify-between w-full">
          {port && (
            <Text className="text-xs text-muted-foreground">
              Port {port}
            </Text>
          )}
          {(toolTimestamp || assistantTimestamp) && (
            <Text className="text-xs text-muted-foreground ml-2">
              {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
            </Text>
          )}
        </View>
      }
    >
      <View className="flex-1 w-full px-4 py-4 gap-6">
        {/* Port Number */}
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
            Local Port
          </Text>
          <View className="bg-card border border-border rounded-2xl p-6 items-center">
            <Text className="text-4xl font-roobert-bold text-primary" selectable>
              {port}
            </Text>
          </View>
        </View>

        {/* Public URL */}
        {publicUrl && !isError && (
          <View className="gap-3">
            <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
              Public URL
            </Text>

            {/* URL Display */}
            <View className="bg-card border border-border rounded-2xl p-4">
              <Text className="text-sm font-roobert text-primary leading-5" selectable>
                {publicUrl}
              </Text>
            </View>

            {/* Action Buttons */}
            <View className="flex-row gap-3">
              <Pressable
                onPress={handleOpenUrl}
                className="flex-1 bg-primary active:opacity-80 rounded-2xl py-4 flex-row items-center justify-center gap-2"
              >
                <Icon as={ExternalLink} size={18} className="text-primary-foreground" />
                <Text className="text-primary-foreground text-base font-roobert-semibold">
                  Open URL
                </Text>
              </Pressable>

              <Pressable
                onPress={handleCopy}
                className="bg-card border border-border active:bg-muted rounded-2xl px-6 py-4 flex-row items-center justify-center gap-2"
              >
                <Icon
                  as={copied ? Check : Copy}
                  size={18}
                  className={copied ? 'text-primary' : 'text-primary'}
                />
                <Text className="text-primary text-base font-roobert-semibold">
                  {copied ? 'Copied!' : 'Copy'}
                </Text>
              </Pressable>
            </View>

            {/* Info Card */}
            <View className="bg-card border border-border rounded-2xl p-4 flex-row gap-3">
              <View className="pt-0.5">
                <Icon as={Share2} size={16} className="text-primary" />
              </View>
              <Text className="flex-1 text-sm font-roobert text-foreground/80 leading-5">
                This URL is publicly accessible and will remain active as long as the server is running.
              </Text>
            </View>
          </View>
        )}

        {/* Status */}
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
            Status
          </Text>
          <View className={`flex-row items-center gap-2 rounded-2xl p-4 border ${isError
            ? 'bg-destructive/5 border-destructive/20'
            : 'bg-primary/5 border-primary/20'
            }`}>
            <Icon
              as={isError ? Globe : Network}
              size={18}
              className={isError ? 'text-destructive' : 'text-primary'}
            />
            <Text className={`text-sm font-roobert-medium ${isError ? 'text-destructive' : 'text-primary'
              }`}>
              {isError ? 'Failed to Expose Port' : 'Port Successfully Exposed'}
            </Text>
          </View>
        </View>
      </View>
    </ToolViewCard>
  );
}
