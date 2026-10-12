import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils/index';

/**
 * What a count means, which picks its tint. Same tones as web's `CountBadge`.
 * - `waiting`: something waits on the user (Review, unread).
 * - `reminder`: active reminders or schedules.
 * - `conflict`: something to resolve.
 * - `done`: finished work.
 * - `neutral`: a plain informational count (members, sub-sessions, tab sizes).
 */
export type CountBadgeTone = 'neutral' | 'waiting' | 'reminder' | 'conflict' | 'done';

const TONE_FILL: Record<CountBadgeTone, string> = {
  neutral: 'bg-foreground/[0.06]',
  waiting: 'bg-kortix-yellow/15',
  reminder: 'bg-kortix-purple/15',
  conflict: 'bg-kortix-orange/15',
  done: 'bg-kortix-green/15',
};

/**
 * The one count pill for a row, button, tab or menu item — web's project
 * sidebar Review count: a 20pt-min tabular pill, 4pt sides, 5pt radius, a 15%
 * tint of its tone, medium text in the row's text colour. Hidden at 0, "99+"
 * above 99. Pass `textClassName` when the row's text is not `text-foreground`
 * (a muted inactive tab), so the number keeps the row's colour.
 */
export function CountBadge({
  count,
  tone = 'neutral',
  textClassName,
  className,
}: {
  count: number;
  tone?: CountBadgeTone;
  textClassName?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <View
      className={cn('min-w-5 items-center rounded-[5px] px-1 py-0.5', TONE_FILL[tone], className)}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      <Text
        className={cn('font-roobert-medium text-xs text-foreground', textClassName)}
        style={{ fontVariant: ['tabular-nums'] }}>
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}
