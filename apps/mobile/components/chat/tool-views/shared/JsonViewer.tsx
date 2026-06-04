import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { log } from '@/lib/logger';

interface JsonViewerProps {
  data: any;
  title: string;
  defaultExpanded?: boolean;
  className?: string;
}

export function JsonViewer({
  data,
  title,
  defaultExpanded = false,
  className = '',
}: JsonViewerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(JSON.stringify(data, null, 2));
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy to clipboard:', err);
    }
  };

  const toggleExpanded = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsExpanded(!isExpanded);
  };

  const jsonString = JSON.stringify(data, null, 2);

  return (
    <View className={`border border-border rounded-xl ${className}`}>
      <View className="flex-row items-center justify-between p-3 border-b border-border bg-muted/30">
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={toggleExpanded}
            className="h-6 w-6 items-center justify-center"
          >
            <Icon
              as={isExpanded ? ChevronDown : ChevronRight}
              size={16}
              className="text-foreground"
            />
          </Pressable>
          <View className="bg-card border border-border rounded-full px-2 py-0.5">
            <Text className="text-xs font-roobert-mono text-foreground">
              {title}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={handleCopy}
          className="h-6 w-6 items-center justify-center"
        >
          <Icon
            as={copied ? Check : Copy}
            size={14}
            className={copied ? 'text-primary' : 'text-foreground/60'}
          />
        </Pressable>
      </View>

      {isExpanded && (
        <View className="p-3">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="bg-background/50 rounded-lg border border-border p-3 max-h-32"
          >
            <Text className="text-xs font-roobert-mono text-foreground/80 whitespace-pre-wrap">
              {jsonString}
            </Text>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

