// apps/mobile/components/kortix/list-row.tsx
import * as React from 'react';
import { View } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { CaretRightIcon as ChevronRight } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils/utils';

interface ListRowProps {
  title: string; subtitle?: string;
  left?: React.ReactNode; right?: React.ReactNode;
  onPress?: () => void; divider?: boolean; className?: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  /** Press feedback scale-down. Off for a list a person scans quickly and
   *  taps often (Review's Needs you/Waiting/Done), where the shrink read as
   *  lag rather than feedback (Jay, 2026-09-22). Default on. */
  scaleOnPress?: boolean;
}
export function ListRow({
  title, subtitle, left, right, onPress, divider = true, className,
  variant = 'default', disabled, scaleOnPress = true,
}: ListRowProps) {
  const destructive = variant === 'destructive';
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) =>
        pressed && !disabled && scaleOnPress ? { transform: [{ scale: 0.98 }] } : undefined
      }
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
      {/* Inset hairline divider — a row inside its own MenuGroup/sheet card
          framing, so this stays a bare Separator rather than a wrapping
          Card (Card's own border/radius/shadow/padding belong to the
          surrounding group, not to each row). w-auto cancels Separator's
          default w-full so left+right absolute offsets compute the width,
          matching the original inset-from-icon, full-to-edge hairline. */}
      {divider ? <Separator className="absolute left-4 right-0 bottom-0 w-auto" /> : null}
    </PressableSurface>
  );
}
