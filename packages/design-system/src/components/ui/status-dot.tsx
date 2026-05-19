import { cn } from '../../lib/utils';

export type StatusTone = 'success' | 'warn' | 'danger' | 'muted' | 'neutral';
export type StatusSize = 'xs' | 'sm' | 'md';

interface Props {
  tone: StatusTone;
  pulse?: boolean;
  size?: StatusSize;
  className?: string;
  label?: string;
}

const TONE: Record<StatusTone, { dot: string; ring: string; ping: string }> = {
  success: {
    dot: 'bg-emerald-400',
    ring: 'ring-emerald-400/30',
    ping: 'bg-emerald-400/60',
  },
  warn: {
    dot: 'bg-amber-300',
    ring: 'ring-amber-300/30',
    ping: 'bg-amber-300/70',
  },
  danger: {
    dot: 'bg-rose-400',
    ring: 'ring-rose-400/30',
    ping: 'bg-rose-400/60',
  },
  muted: {
    dot: 'bg-muted-foreground/55',
    ring: 'ring-muted-foreground/15',
    ping: 'bg-muted-foreground/40',
  },
  neutral: {
    dot: 'bg-foreground/80',
    ring: 'ring-foreground/15',
    ping: 'bg-foreground/40',
  },
};

const SIZE: Record<StatusSize, string> = {
  xs: 'size-1',
  sm: 'size-1.5',
  md: 'size-2',
};

const RING: Record<StatusSize, string> = {
  xs: 'ring-1',
  sm: 'ring-2',
  md: 'ring-2',
};

export function StatusDot({ tone, pulse = false, size = 'md', className, label }: Props) {
  const t = TONE[tone];
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      className={cn('relative inline-flex shrink-0', SIZE[size], className)}
    >
      {pulse ? (
        <span aria-hidden className={cn('absolute inset-0 animate-ping rounded-full', t.ping)} />
      ) : null}
      <span
        aria-hidden
        className={cn('relative rounded-full', SIZE[size], RING[size], t.dot, t.ring)}
      />
    </span>
  );
}
