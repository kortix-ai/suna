// apps/mobile/components/ui/list-row.tsx
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { Text } from './text';
import { Icon } from './icon';
import { cn } from '@/lib/utils/utils';

interface ListRowProps {
  title: string; subtitle?: string;
  left?: React.ReactNode; right?: React.ReactNode;
  onPress?: () => void; divider?: boolean; className?: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
}
export function ListRow({
  title, subtitle, left, right, onPress, divider = true, className,
  variant = 'default', disabled,
}: ListRowProps) {
  const destructive = variant === 'destructive';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => (pressed && !disabled ? { transform: [{ scale: 0.98 }] } : undefined)}
      className={cn(
        'flex-row items-center gap-3 px-4 py-3.5',
        destructive ? 'active:bg-destructive/10' : 'active:bg-foreground/[0.03]',
        disabled && 'opacity-50',
        className,
      )}>
      {left}
      <View className="flex-1">
        <Text
          className={cn('font-roobert-medium text-[15px]', destructive ? 'text-destructive' : 'text-foreground')}
          numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text className="font-roobert text-xs text-muted-foreground mt-0.5" numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right !== undefined
        ? right
        : onPress && !destructive
          ? <Icon as={ChevronRight} size={18} className="text-muted-foreground" />
          : null}
      {divider ? <View className="absolute left-4 right-0 bottom-0 h-px bg-border" /> : null}
    </Pressable>
  );
}
