/**
 * Empty State Component
 *
 * Consistent empty state design used throughout the app
 * Matches the design pattern from TriggersScreen
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { LucideIcon } from 'lucide-react-native';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onActionPress?: () => void;
  className?: string;
}

export function EmptyState({
  icon: IconComponent,
  title,
  description,
  actionLabel,
  onActionPress,
  className = '',
}: EmptyStateProps) {
  return (
    <View
      className={`items-center justify-center rounded-2xl border border-border bg-card p-8 ${className}`}>
      <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
        <Icon as={IconComponent} size={24} className="text-muted-foreground" />
      </View>
      <Text className="mb-1 font-roobert-semibold text-base text-foreground">{title}</Text>
      <Text className="mb-4 text-center text-sm text-muted-foreground">{description}</Text>
      {actionLabel && onActionPress && (
        <Pressable
          onPress={onActionPress}
          className="rounded-xl bg-primary px-4 py-2 active:opacity-80">
          <Text className="font-roobert-semibold text-sm text-primary-foreground">
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

