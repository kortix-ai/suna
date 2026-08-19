'use client';

/**
 * One channel as an entity row — the shape that replaced the four-column
 * channel `<Table>` in `channels-view.tsx`.
 *
 * **Why the table went.** The old header was Platform / Status / Workspace /
 * Actions. With nothing connected — the state a new workspace is always in —
 * every row read "Not connected" in column two and an em dash in column
 * three. A table's job is to let you compare values down a column; there were
 * no values. It was a grid drawn around three buttons.
 *
 * The row form fixes the specific thing that costs a non-technical user the
 * most: the second line is never an em dash. Disconnected, it says what the
 * channel DOES ("Email your agent and it replies to the thread"). Connected,
 * it says which workspace or address you are wired to. Either way it answers a
 * question instead of holding a placeholder.
 *
 * Status is a dot, not a badge. A `Badge` on every row in a list of three
 * reads as three competing labels; a 6px dot in the platform's status colour
 * carries the same bit with none of the visual noise, and the word next to it
 * stays in the muted meta line where the rest of the row's detail lives.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

/** Local, not exported — `ChannelRow` is the only sanctioned way to draw it. */
function ChannelStatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        connected ? 'bg-kortix-green' : 'bg-muted-foreground/40',
      )}
    />
  );
}

export function ChannelRow({
  icon,
  name,
  connected,
  /** Shown when connected — the workspace, tenant, or address we're bound to. */
  detail,
  /** Shown when NOT connected — what this channel gets you, in one line. */
  pitch,
  badge,
  actions,
}: {
  icon: React.ReactNode;
  name: string;
  connected: boolean;
  detail?: string | null;
  pitch: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5">
      <span className="bg-muted/60 flex size-9 shrink-0 items-center justify-center rounded-sm">
        {icon}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-foreground text-sm font-medium">{name}</p>
          {badge}
        </div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <ChannelStatusDot connected={connected} />
          {connected ? (
            <span className="max-w-[240px] truncate" title={detail ?? undefined}>
              Connected{detail ? ` · ${detail}` : ''}
            </span>
          ) : (
            <span className="truncate">{pitch}</span>
          )}
        </div>
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </li>
  );
}

/**
 * Disconnect as a two-step inline swap (Disconnect → Cancel | Disconnect).
 *
 * The design system requires a confirmation before any destructive mutation
 * and sanctions this inline swap as the one alternative to `ConfirmDialog` —
 * it is the pattern the channel rows already used, kept deliberately so a
 * misclick in a list of three rows can never sever a live integration.
 */
export function ChannelDisconnectButton({
  pending,
  onConfirm,
}: {
  pending: boolean;
  onConfirm: (done: () => void) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={() => setConfirming(true)}
      >
        <XIcon className="size-3.5 shrink-0" />
        Disconnect
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        size="sm"
        className="gap-1.5"
        disabled={pending}
        onClick={() => onConfirm(() => setConfirming(false))}
      >
        {pending ? <Loading className="size-3.5 shrink-0" /> : null}
        Disconnect
      </Button>
    </>
  );
}

/** "Advanced" / "Experimental" style marker for a row or panel heading. */
export function ChannelHintBadge({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="outline" size="xs" className="text-muted-foreground">
      {children}
    </Badge>
  );
}
