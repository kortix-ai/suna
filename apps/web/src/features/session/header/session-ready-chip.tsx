'use client';

/**
 * The Ready moment (W1): a run finished while the panel was closed, and this
 * is what says so. It sits beside the panel toggle, reads the one chip the
 * readiness hook wrote, and a tap opens the panel with the primary deliverable
 * already open — the deliverable comes to the user, not the other way around.
 *
 * It complements the notification system rather than duplicating it: toasts
 * and OS notifications cover the user who is elsewhere; this covers the user
 * who is right here, watching, with nothing else to tell them the run ended.
 */

import { Button } from '@/components/ui/button';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { type ReadyChipState, useKortixComputerStore } from '@/stores/kortix-computer-store';
import { AlertTriangle, CircleHelp, FileCheck, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useSyncExternalStore } from 'react';

function chipLabel(chip: ReadyChipState): string {
  switch (chip.outcome) {
    case 'ready':
      if (chip.primaryName) return `${chip.primaryName} is ready`;
      // "files" undersells a run whose deliverables aren't all files (a live
      // app, a deck) — "results" covers every kind without naming one.
      return chip.count === 1 ? '1 result ready' : `${chip.count} results ready`;
    case 'failed':
      return 'Something went wrong';
    case 'stopped':
      return 'Stopped before finishing';
    case 'needs_input':
      return 'Needs your input';
  }
}

const CHIP_ICON = {
  ready: FileCheck,
  failed: AlertTriangle,
  stopped: AlertTriangle,
  needs_input: CircleHelp,
} as const;

// zustand v5's own hook (`useReadyChip`, and `useStore` generally) feeds
// React's `useSyncExternalStore` a `getServerSnapshot` pinned to
// `getInitialState()` — correct for real SSR (a `readyChip` can only ever be
// set by a client-side event, so it is genuinely always null at request
// time), but it means a real server-render dispatcher (which is exactly what
// `renderToStaticMarkup` uses) can never observe a `setReadyChip` call that
// happened earlier in the same process, as this component's own render test
// needs to. Reading through `getState()` for both snapshots sidesteps that —
// same live value, same reactivity via `subscribe`, and no behavior change
// in the browser or in real SSR (where the value is null in both cases).
const getReadyChipSnapshot = () => useKortixComputerStore.getState().readyChip;

export function SessionReadyChip({ sessionId }: { sessionId: string }) {
  const chip = useSyncExternalStore(
    useKortixComputerStore.subscribe,
    getReadyChipSnapshot,
    getReadyChipSnapshot,
  );
  const reduce = useReducedMotion();

  if (!chip || chip.sessionId !== sessionId) return null;

  const Icon = CHIP_ICON[chip.outcome];
  const amber = chip.outcome === 'needs_input';
  const red = chip.outcome === 'failed';
  // 'stopped' isn't a success — it's a neutral interruption, so it gets the
  // same AlertTriangle glyph as 'failed' but without the alarm color (kortix
  // color doctrine: idle/neutral states read as muted-foreground, not green).
  const neutral = chip.outcome === 'stopped';

  const open = () => {
    const store = useKortixComputerStore.getState();
    track('ready_chip_clicked', { outcome: chip.outcome });
    track('panel_opened', { source: 'chip' });
    if (chip.outcome === 'ready') store.requestPrimaryOpen(sessionId);
    store.openSidePanel(); // clears the chip (Task 5 contract)
  };

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="border-border bg-popover shadow-xs flex h-7 items-center gap-1 rounded-md border pr-0.5 pl-2"
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          amber
            ? 'text-kortix-orange'
            : red
              ? 'text-kortix-red'
              : neutral
                ? 'text-muted-foreground'
                : 'text-kortix-green',
        )}
      />
      <button
        type="button"
        onClick={open}
        className="text-foreground flex min-w-0 cursor-pointer items-baseline gap-1.5 text-xs"
      >
        <span className="max-w-40 truncate">{chipLabel(chip)}</span>
        <span className="text-muted-foreground shrink-0 font-medium">View</span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Dismiss"
        onClick={() => useKortixComputerStore.getState().clearReadyChip()}
        className="size-7 active:scale-[0.96]"
      >
        <X className="size-3" />
      </Button>
    </motion.div>
  );
}
