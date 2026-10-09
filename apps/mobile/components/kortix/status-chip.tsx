/**
 * An informational status chip (web's `StatusBadge`): the tone is a /15 tint
 * of its colour, the label stays ink, so "bad" reads as a fact, not an error.
 * Neutral takes no hue. Not a control: no border, no press state.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

export type StatusChipTone = 'neutral' | 'success' | 'warning' | 'destructive';

const TINT: Record<StatusChipTone, string> = {
  neutral: 'bg-secondary',
  success: 'bg-kortix-green/15',
  warning: 'bg-kortix-orange/15',
  destructive: 'bg-kortix-red/15',
};

export function StatusChip({ tone = 'neutral', children }: { tone?: StatusChipTone; children: ReactNode }) {
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${TINT[tone]}`}>
      {/* `small` is leading-none; one line needs text-sm's 20pt line (AGENTS.md → Text). */}
      <Text variant="small" numberOfLines={1} className="leading-5 text-foreground">
        {children}
      </Text>
    </View>
  );
}
