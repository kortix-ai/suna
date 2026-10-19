import { Badge } from './badge';
import { cn } from '../../lib/utils';

/**
 * THE count beside a label: a sidebar row, a tab, a menu item, a button. The
 * project sidebar's Review count is the reference: a tabular pill in the
 * row's own text colour on a 15% tint, clamped at 99+ so it never pushes the
 * label into an ellipsis. The tint carries the meaning, never decoration:
 *
 * - `waiting`: something waits on the person (Review, changes to review).
 * - `reminder`: active reminders.
 * - `conflict`: conflicts to resolve.
 * - `neutral`: a plain tally (members, child sessions, a group's size).
 *
 * An overlay badge on an icon button's corner is a different pattern and does
 * not use this.
 */
const TONE = {
  neutral: 'bg-foreground/6',
  waiting: 'bg-kortix-yellow/15',
  reminder: 'bg-kortix-purple/15',
  conflict: 'bg-kortix-orange/15',
} as const;

export type CountBadgeTone = keyof typeof TONE;

export function CountBadge({
  count,
  tone = 'neutral',
  className,
  ...props
}: { count: number; tone?: CountBadgeTone } & Omit<React.ComponentProps<'span'>, 'children'>) {
  return (
    <Badge
      variant="transparent"
      size="tabular"
      className={cn(TONE[tone], 'shrink-0 text-current', className)}
      {...props}
    >
      {count > 99 ? '99+' : count}
    </Badge>
  );
}
