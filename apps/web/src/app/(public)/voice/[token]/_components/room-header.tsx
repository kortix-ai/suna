'use client';

import { StatusDot, type StatusTone } from '@/components/ui/status';

import type { ConnectionPhase } from './types';

const STATUS: Record<ConnectionPhase, { label: string; tone: StatusTone; pulse?: boolean }> = {
  connecting: { label: 'Connecting…', tone: 'neutral', pulse: true },
  connected: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting…', tone: 'warning', pulse: true },
  failed: { label: 'Disconnected', tone: 'destructive' },
  left: { label: 'Left', tone: 'neutral' },
};

export function RoomHeader({ phase }: { phase: ConnectionPhase }) {
  const status = STATUS[phase];
  return (
    <header className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- small static brand mark, not worth next/image */}
        <img src="/kortix-symbol.svg" alt="" className="dark:invert-0 size-4 invert" aria-hidden />
        <span className="text-foreground text-sm font-medium">dosco voice call</span>
      </div>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <StatusDot tone={status.tone} pulse={status.pulse} />
        {status.label}
      </div>
    </header>
  );
}
