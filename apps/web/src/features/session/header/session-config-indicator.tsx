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
import { dismissToast, warningToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

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

  const stale = notice.kind === 'stale';

  // A toast as well as the chip, because the chip alone was not found.
  //
  // The chip is correct and stays — it is the durable, always-available
  // affordance, and it is where you look once you know the concept exists. But
  // it is an icon in a header, and a session that silently runs the wrong agent
  // is exactly the case where the user does NOT already know to look. So the
  // arrival of staleness also gets announced once, where new information
  // belongs.
  //
  // Announced ONCE per distinct config version, not once per render and not
  // again after dismissal: `shownFor` keys on the etag pair, so re-checks of the
  // same staleness stay quiet and only a genuinely newer config speaks up again.
  // Persistent (`Infinity`) because it reports a condition, not an event — it
  // stays true until acted on — and `warningToast` already carries its own close
  // button, so it is dismissible without being self-dismissing.
  const toastId = `session-config-stale-${sessionId}`;
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (notice.kind !== 'stale') {
      // Retract on the way out. After a successful reload the condition is gone,
      // and a lingering card offering to fix it would be worse than no card.
      if (shownFor.current !== null) {
        shownFor.current = null;
        dismissToast(toastId);
      }
      return;
    }
    const version = `${notice.running}->${notice.latest}`;
    if (shownFor.current === version) return;
    shownFor.current = version;
    warningToast('Agent config is out of date', {
      id: toastId,
      description:
        'This session is running an older version of the agent config. Your commits and other files are untouched.',
      duration: Number.POSITIVE_INFINITY,
      button: (
        <Button size="sm" disabled={!canReload || isPending} onClick={() => reload()}>
          {isPending ? <Loading className="size-4 shrink-0" /> : null}
          Reload config
        </Button>
      ),
    });
  }, [notice, toastId, reload, canReload, isPending]);

  // The confirm is rendered by the header, not here — see `SessionConfigReloadConfirm`.
  // This component may vanish the moment a reload lands, and a dialog that
  // unmounts mid-question is worse than no dialog.
  if (notice.kind === 'hidden') return null;

  const label = stale ? 'Agent config is out of date' : "Can't confirm the agent config";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint side="bottom" sideOffset={4} delayDuration={300} label={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} className="relative">
            <span className="relative inline-flex">
              <ArrowsClockwiseIcon className="text-foreground size-4" />
              <span
                className={cn(
                  'ring-background absolute -top-1 -right-1 size-2 rounded-full ring-2',
                  // Orange is "needs attention"; a session we merely could not
                  // ask about has not done anything wrong, so it stays neutral.
                  stale ? 'bg-kortix-orange' : 'bg-muted-foreground',
                )}
                aria-hidden
              />
            </span>
          </Button>
        </PopoverTrigger>
      </Hint>

      <PopoverContent align="end" sideOffset={8} className="w-[320px] overflow-hidden p-0">
        <div className="border-border border-b px-4 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md',
                // Spelled literally rather than via STATUS_BG/STATUS_TEXT:
                // those pair a kortix-yellow fill with a raw amber foreground,
                // which is both off-token and a different colour from every
                // other "needs attention" surface in the app.
                stale
                  ? 'bg-kortix-orange/10 text-kortix-orange'
                  : 'text-muted-foreground border-border border',
              )}
            >
              <ArrowsClockwiseIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-foreground truncate text-sm font-semibold tracking-tight">
                {label}
              </h3>
            </div>
          </div>

          <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
            {stale
              ? // Only ONE unconditional promise is made here — that nothing of
                // yours is lost — because that one is structural: the reload
                // never moves the branch. Bringing the agent files forward is
                // deliberately worded as an attempt, since the reload refuses
                // when this session has edited them itself. The toast afterwards
                // reports which of the two happened.
                'This session started with an older version of the agent config. Reloading tries to bring its agent files up to date, and keeps any changes this session made to them. Your commits and other files are untouched.'
              : "This session's runtime didn't report which agent config it's running, so we can't tell whether it's current. Reloading puts it on the latest."}
          </p>

          {notice.kind === 'stale' && (
            <p className="text-muted-foreground mt-2.5 font-mono text-[11px]">
              <span className="text-foreground/80">{notice.running}</span>
              {' → '}
              <span className="text-foreground/80">{notice.latest}</span>
            </p>
          )}
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
