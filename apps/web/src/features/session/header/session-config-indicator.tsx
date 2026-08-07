'use client';

/**
 * "This session is running an older version of your agent" — said in the header.
 *
 * Sibling of `SessionChangesIndicator`, and deliberately built to the same
 * shape: an icon-only ghost button with a dot, opening a popover that explains
 * the condition and carries the one button that fixes it.
 *
 * It is in the HEADER rather than inline in the transcript because staleness is
 * ambient session state, not a reply to a message. The inline slot next to
 * `ConnectorRequiredNotice` is bound to the last send's error — a card there
 * would scroll away, then re-anchor under an unrelated message.
 *
 * Like the changes chip, it renders NOTHING when there is nothing to say. A
 * permanent "config up to date" badge would be chrome on every session, forever,
 * to report the case that is true almost always.
 */

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  type ReloadBusyReason,
  useSessionConfigFreshness,
} from '@/hooks/projects/use-session-config-freshness';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { useState } from 'react';

/** The server's two refusals, as something a person would actually read. */
const BUSY_COPY: Record<ReloadBusyReason, { title: string; body: string; tail: string }> = {
  'session is mid-turn': {
    title: 'This session is mid-turn',
    body: "Reloading restarts the runtime, which ends the turn that's running right now. Whatever the agent is part-way through will be lost.",
    tail: 'Wait for it to finish, or reload anyway.',
  },
  'could not confirm the session is idle': {
    title: "Couldn't confirm this session is idle",
    body: "We couldn't reach the runtime to ask whether a turn is running. Reloading restarts it, and if one is in flight it will be lost.",
    tail: 'Try again in a moment, or reload anyway.',
  },
};

export function SessionConfigIndicator({
  projectId,
  sessionId,
  reload,
  isPending,
  canReload,
}: {
  projectId: string;
  sessionId: string;
  /** Hoisted to the header so the ⋯ item and this chip share one pending state. */
  reload: (vars?: { force?: boolean }) => void;
  isPending: boolean;
  canReload: boolean;
}) {
  const { notice } = useSessionConfigFreshness(projectId, sessionId);
  const [open, setOpen] = useState(false);

  // The confirm is rendered by the header, not here — see `SessionConfigReloadConfirm`.
  // This component may vanish the moment a reload lands, and a dialog that
  // unmounts mid-question is worse than no dialog.
  if (notice.kind === 'hidden') return null;

  const label = 'Agent config update available';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint side="bottom" sideOffset={4} delayDuration={300} label={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} className="relative">
            <span className="relative inline-flex">
              <ArrowsClockwiseIcon className="text-foreground size-4" />
              <span
                className="ring-background bg-kortix-orange absolute -top-1 -right-1 size-2 rounded-full ring-2"
                aria-hidden
              />
            </span>
          </Button>
        </PopoverTrigger>
      </Hint>

      <PopoverContent align="end" sideOffset={8} className="w-[320px] overflow-hidden p-0">
        <div className="border-border border-b px-4 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="bg-kortix-orange/10 text-kortix-orange flex size-8 shrink-0 items-center justify-center rounded-md">
              <ArrowsClockwiseIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-foreground truncate text-sm font-semibold tracking-tight">
                {label}
              </h3>
            </div>
          </div>

          <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
            A newer agent config is available. Reloading restarts the agent runtime and leaves every
            project file and commit unchanged.
          </p>

          <p className="text-muted-foreground mt-2.5 font-mono text-[11px]">
            <span className="text-foreground/80">{notice.running}</span>
            {' → '}
            <span className="text-foreground/80">{notice.latest}</span>
          </p>
        </div>

        {canReload ? (
          <div className="border-border flex items-center gap-2 border-t px-3 py-2.5">
            <Button size="sm" disabled={isPending} onClick={() => reload()}>
              {isPending ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <ArrowsClockwiseIcon className="size-3.5 shrink-0" />
              )}
              Reload config
            </Button>
          </div>
        ) : (
          // The API gates reload on session-owner-or-manager. A button that
          // only ever 403s is worse than a sentence saying who can press it.
          <div className="border-border border-t px-4 py-2.5">
            <p className="text-muted-foreground text-xs text-pretty">
              The session owner or a project manager can reload it.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The force-reload confirmation, mounted by the header.
 *
 * Separate from the chip on purpose: a successful reload can make the chip
 * disappear, and this dialog must survive long enough to ask its question. It
 * is a `ConfirmDialog` rather than a second click because `force` discards a
 * turn that is running right now.
 */
export function SessionConfigReloadConfirm({
  busyReason,
  isPending,
  onConfirm,
  onDismiss,
}: {
  busyReason: ReloadBusyReason | null;
  isPending: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const copy = busyReason ? BUSY_COPY[busyReason] : null;
  return (
    <ConfirmDialog
      open={!!copy}
      onOpenChange={(next) => !next && onDismiss()}
      title={copy?.title ?? ''}
      description={
        <>
          <p>{copy?.body}</p>
          <p className="mt-2">{copy?.tail}</p>
        </>
      }
      confirmLabel="Reload anyway"
      cancelLabel="Wait"
      confirmVariant="destructive"
      confirmIcon={<ArrowsClockwiseIcon className="size-3.5" />}
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
