/**
 * Expose Port Tool View
 * 
 * Specialized view for port exposure operations
 */

import React, { useState } from 'react';
import { View, Pressable, Linking, Clipboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import { 
  Globe, 
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Share2
} from 'lucide-react-native';
import type { ToolViewProps } from './types';

export function ExposePortToolView({ toolData }: ToolViewProps) {
  const { arguments: toolArgs, result } = toolData;
  const [copied, setCopied] = useState(false);
  const isError = !result.success;

  const port = toolArgs.port;
  const publicUrl = result.output?.url || result.output?.public_url || '';

  const handleCopy = async () => {
    if (publicUrl) {
      Clipboard.setString(publicUrl);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      console.log('📋 Copied public URL to clipboard');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenUrl = async () => {
    if (publicUrl) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('🌐 Opening public URL:', publicUrl);
      const canOpen = await Linking.canOpenURL(publicUrl);
      if (canOpen) {
        await Linking.openURL(publicUrl);
      }
    }
  };

  return (
    <View className="px-6 py-4 gap-6">
      {/* Header */}
      <View className="flex-row items-center gap-3">
        <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
          <Icon as={Globe} size={24} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            Port Exposure
          </Text>
          <Text className="text-xl font-roobert-semibold text-foreground">
            Port Exposed
          </Text>
        </View>
      </View>

      {/* Port Number */}
      <View className="gap-2">
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          Local Port
        </Text>
        <View className="bg-primary/10 border border-primary/20 rounded-2xl p-6 items-center">
          <Text className="text-4xl font-roobert-bold text-primary" selectable>
            {port}
          </Text>
        </View>
      </View>

      {/* Public URL */}
      {publicUrl && !isError && (
        <View className="gap-3">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Public URL
          </Text>
          
          {/* URL Display */}
          <View className="bg-primary/5 border border-primary/20 rounded-2xl p-4">
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
              <Icon as={ExternalLink} size={18} className="text-white" />
              <Text className="text-white text-base font-roobert-semibold">
                Open URL
              </Text>
            </Pressable>
            
            <Pressable
              onPress={handleCopy}
              className="bg-primary/10 border border-primary/20 active:bg-primary/20 rounded-2xl px-6 py-4 flex-row items-center justify-center gap-2"
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
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          Status
        </Text>
        <View className={`flex-row items-center gap-2 rounded-2xl p-4 border ${
          isError 
            ? 'bg-destructive/5 border-destructive/20' 
            : 'bg-primary/5 border-primary/20'
        }`}>
          <Icon 
            as={isError ? AlertCircle : CheckCircle2} 
            size={18} 
            className={isError ? 'text-destructive' : 'text-primary'} 
          />
          <Text className={`text-sm font-roobert-medium ${
            isError ? 'text-destructive' : 'text-primary'
          }`}>
            {isError ? 'Failed to Expose Port' : 'Port Successfully Exposed'}
          </Text>
        </View>
      </View>
    </View>
  );
}
