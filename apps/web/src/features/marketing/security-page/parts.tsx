import { cn } from '@kortix/ui';

/*
 * The verdict mark the /security page shares. Hue only on a mark that reports
 * a state: Allow green, Ask yellow (pending), Block red, the same tints
 * `code-panel.tsx` gives the policy actions. The word carries the meaning.
 */

export type VerdictKind = 'allow' | 'ask' | 'block';

const VERDICT: Record<VerdictKind, { dot: string; tint: string }> = {
  allow: { dot: 'bg-kortix-green', tint: 'bg-kortix-green/15' },
  ask: { dot: 'bg-kortix-yellow', tint: 'bg-kortix-yellow/15' },
  block: { dot: 'bg-kortix-red', tint: 'bg-kortix-red/15' },
};

export function Verdict({ kind, label }: { kind: VerdictKind; label: string }) {
  const tone = VERDICT[kind];
  return (
    <span
      className={cn(
        'text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium',
        tone.tint,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
      {label}
    </span>
  );
}
