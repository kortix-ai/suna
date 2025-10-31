import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';

interface AuthDividerProps {
  text?: string;
}

/**
 * AuthDivider Component
 * 
 * Horizontal divider with optional text
 * Used to separate OAuth and email/password sections
 * 
 * Default text: "or email"
 */
export function AuthDivider({ text = 'or email' }: AuthDividerProps) {
  return (
    <View className="flex-row items-center w-full gap-3">
      <View className="flex-1 h-px bg-border/20" />
      <Text className="text-muted-foreground text-[14px] font-roobert-medium tracking-wide">
        {text}
      </Text>
      <View className="flex-1 h-px bg-border/20" />
    </View>
  );
}

