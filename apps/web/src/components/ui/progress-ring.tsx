import { cn } from '@/lib/utils';

const R = 7;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ProgressRing({
  value,
  className,
  trackClassName = 'text-foreground/10',
  progressClassName = 'text-muted-foreground',
}: {
  value: number;
  className?: string;
  trackClassName?: string;
  progressClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <svg viewBox="0 0 18 18" className={cn('size-4 -rotate-90', className)} fill="none">
      <circle
        cx="9"
        cy="9"
        r={R}
        stroke="currentColor"
        strokeWidth="2"
        className={trackClassName}
      />
      <circle
        cx="9"
        cy="9"
        r={R}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className={cn('transition-[stroke-dashoffset] duration-500', progressClassName)}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
      />
    </svg>
  );
}
