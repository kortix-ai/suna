'use client';

import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';
import { useTranslations } from '../../i18n';
/**
 * "This session is running an older version of your agent" — said in the header.
 *
 * Sibling of `SessionChangesIndicator`, and deliberately built to the same
 * shape: an icon-only ghost button with a dot, opening a popover that explains
 * the condition and carries the one button that fixes it.
 *
 * It is in the HEADER rather than inline in the transcript because staleness is
 * ambient session state, not a reply to a message — unlike a send failure,
 * which `TurnErrorDisplay` renders inline, bound to the message that
 * triggered it.
 *
 * Like the changes chip, it renders NOTHING when there is nothing to say. A
 * permanent "config up to date" badge would be chrome on every session, forever,
 * to report the case that is true almost always.
 */

import { CopyButton } from '../../markdown/copy-button';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import Hint from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { errorToast, successToast } from '../../primitives/toast';
import { genuiBadgeClass } from '../../markdown/genui/components/inline';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { buildAgentGitReconciliationPrompt } from '../status/agent-git-reconciliation';
import { reloadProgressText } from '../../internal/hooks/projects/session-reload-progress';
import {
  type ReloadBusyReason,
  type SessionConfigNotice,
  useSessionConfigFreshness,
} from '../../internal/hooks/projects/use-session-config-freshness';
import { cn } from '../../lib/utils';
import { useChatSendStore } from '../../internal/stores/chat-send-store';
import type { SessionReloadPhase } from '@kortix/sdk';
import { ArrowsClockwiseIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { SessionReloadProgressView } from './session-reload-progress-view';

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
  chatSessionId,
  baseRef,
  reload,
  isPending,
  phase,
  canReload,
}: {
  projectId: string;
  sessionId: string;
  chatSessionId: string;
  baseRef?: string | null;
  /** Hoisted to the header so the ⋯ item and this chip share one pending state. */
  reload: (vars?: { force?: boolean }) => void;
  isPending: boolean;
  phase: SessionReloadPhase | null;
  canReload: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { notice } = useSessionConfigFreshness(projectId, sessionId);
  const [open, setOpen] = useState(false);
  const [isAskingAgent, setIsAskingAgent] = useState(false);
  const sendToSession = useChatSendStore((state) => state.sendToSession);

  const askAgentToSync = async () => {
    if (isAskingAgent) return;
    setIsAskingAgent(true);
    try {
      const disposition = await sendToSession(
        chatSessionId,
        buildAgentGitReconciliationPrompt(baseRef),
      );
      successToast(
        disposition === tI18nComplete.raw('textd36be6494248')
          ? tI18nComplete.raw('textb11e0f2cb028')
          : tI18nComplete.raw('texta56be319eda4'),
      );
      setOpen(false);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : tI18nComplete.raw('text29490fc13cfc'));
    } finally {
      setIsAskingAgent(false);
    }
  };

  // The confirm is rendered by the header, not here — see `SessionConfigReloadConfirm`.
  // This component may vanish the moment a reload lands, and a dialog that
  // unmounts mid-question is worse than no dialog.
  if (notice.kind === 'hidden' && !isPending) return null;
  if (!isPending && notice.kind === 'fallback')
    return <SessionConfigFallbackChip notice={notice} />;

  const label = isPending
    ? reloadProgressText(phase, tI18nComplete)
    : tI18nComplete.raw('textc6b12eb62d1c');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint side="bottom" sideOffset={4} delayDuration={300} label={label}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size={isPending ? 'sm' : 'icon'}
            aria-label={label}
            className={isPending ? 'h-8 max-w-56 gap-1.5 px-2' : 'relative'}
          >
            {isPending ? (
              <>
                <Loading className="size-3.5 shrink-0" />
                <span className="truncate text-xs" aria-live="polite">
                  {reloadProgressText(phase, tI18nComplete)}
                </span>
              </>
            ) : (
              <span className="relative inline-flex">
                <ArrowsClockwiseIcon className="text-foreground size-4" />
                <span
                  className="ring-background bg-kortix-orange absolute -top-1 -right-1 size-2 rounded-full ring-2"
                  aria-hidden
                />
              </span>
            )}
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
                {isPending ? tI18nComplete.raw('text06a8fc899ccb') : label}
              </h3>
            </div>
          </div>

          {isPending ? (
            <SessionReloadProgressView phase={phase} />
          ) : (
            <>
              <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
                {tI18nComplete.raw('text69ea5dbbb997')}
              </p>

              <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {tI18nComplete.raw('textaa821f12cbc6')}
              </p>

              <p className="text-muted-foreground mt-2.5 font-mono text-xs">
                <span className="text-foreground">
                  {notice.kind === 'stale' ? notice.running : '—'}
                </span>
                {' → '}
                <span className="text-foreground">
                  {notice.kind === 'stale' ? notice.latest : '—'}
                </span>
              </p>
            </>
          )}
        </div>

        {isPending ? (
          <div className="px-4 py-2.5">
            <p className="text-muted-foreground text-xs">{tI18nComplete.raw('texta8f4dc742e8f')}</p>
          </div>
        ) : canReload ? (
          <div className="border-border flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
            <Button size="sm" disabled={isPending} onClick={() => reload()}>
              {isPending ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <ArrowsClockwiseIcon className="size-3.5 shrink-0" />
              )}
              {tI18nComplete.raw('textb4b21a20cc58')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending || isAskingAgent}
              onClick={askAgentToSync}
            >
              {isAskingAgent ? <Loading className="size-3.5 shrink-0" /> : null}
              {tI18nComplete.raw('textb301cac49225')}
            </Button>
          </div>
        ) : (
          // The API gates reload on session-owner-or-manager. A button that
          // only ever 403s is worse than a sentence saying who can press it.
          <div className="border-border border-t px-4 py-2.5">
            <p className="text-muted-foreground text-xs text-pretty">
              {tI18nComplete.raw('textce49e021df99')}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The host a network error names, so a person can read and search it without
 * parsing the raw message. Null when the reason names none.
 */
export function fallbackErrorHost(reason: string): string | null {
  return reason.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i)?.[1] ?? null;
}

/**
 * `fallback_reason` set: the desired config failed on the box, and an earlier
 * config serves the session. The chip stays until a convergence succeeds.
 *
 * Amber, not red: the session still works. The popover is two rows — the
 * release that failed and the one serving — and the raw error stays folded
 * until someone asks for it.
 */
function SessionConfigFallbackChip({
  notice,
}: {
  notice: Extract<SessionConfigNotice, { kind: 'fallback' }>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = tI18nComplete.raw('textb346c1b839cb');
  const servingLabel =
    notice.source === 'release'
      ? tI18nComplete.raw('text00ed4c71dc2b')
      : tI18nComplete.raw('textbd7a1a3b4141');
  const host = fallbackErrorHost(notice.reason);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid="session-config-fallback-chip"
          className={cn(
            genuiBadgeClass('warning'),
            'h-7 max-w-56 gap-1.5 rounded-sm px-2 py-0 transition-transform active:scale-[0.96]',
          )}
        >
          <WarningCircleIcon weight="fill" className="text-kortix-orange size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[340px] overflow-hidden p-0"
        data-testid="session-config-fallback-detail"
      >
        <div className="px-4 pt-3.5 pb-2.5">
          <h3 className="text-foreground text-sm font-semibold tracking-tight text-balance">
            {tI18nComplete.raw('text7cda1d1355a0')}
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed text-pretty">
            {tI18nComplete.raw('textdf6f45b0b6d0')}
          </p>
        </div>

        <ol className="px-4 pt-1 pb-3.5">
          <li className="flex gap-3">
            <span className="flex w-5 shrink-0 flex-col items-center">
              <XCircleIcon weight="fill" className="text-kortix-red size-5" />
              <span className="bg-border my-1 w-px flex-1" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-foreground text-sm font-medium">
                  {tI18nComplete.raw('textb9b5df3315d1')}
                </span>
                {notice.failedReleaseId ? (
                  <span className="text-muted-foreground font-mono text-xs">
                    {notice.failedReleaseId}
                  </span>
                ) : null}
              </div>
              <p className="text-kortix-red text-xs">{tI18nComplete.raw('text3d2301d732a7')}</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex w-5 shrink-0 justify-center">
              <SolidCheckIcon className="text-kortix-green size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-foreground text-sm font-medium">{servingLabel}</span>
                {notice.servingReleaseId ? (
                  <span className="text-muted-foreground font-mono text-xs">
                    {notice.servingReleaseId}
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text52a4b8f845a4')}
              </p>
            </div>
          </li>
        </ol>

        <div
          className="border-border space-y-2.5 border-t px-4 py-3"
          data-testid="session-config-fallback-error"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs font-medium">
              {tI18nComplete.raw('text54a0e8c17ebb')}
              {notice.failedReleaseId ? (
                <span className="ml-1.5 font-mono">{notice.failedReleaseId}</span>
              ) : null}
            </span>
            <CopyButton
              code={notice.reason}
              size="sm"
              hintSide="top"
              label={tI18nComplete.raw('texte21f935f11d7')}
            />
          </div>
          <pre className="border-border text-foreground max-h-40 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {notice.reason}
          </pre>
          {host ? (
            <dl className="flex gap-3 text-xs">
              <dt className="text-muted-foreground w-10 shrink-0">
                {tI18nComplete.raw('text4a823118b9ba')}
              </dt>
              <dd className="text-foreground min-w-0 font-mono break-all">{host}</dd>
            </dl>
          ) : null}
        </div>

        <p className="border-border text-muted-foreground border-t px-4 py-2.5 text-xs">
          {tI18nComplete.raw('textfd01ebfc09ff')}
        </p>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const busyCopy = useLocalizedUiCatalog(BUSY_COPY);
  const copy = busyReason ? busyCopy[busyReason] : null;
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
      confirmLabel={tI18nComplete.raw('textd5dfe5707a58')}
      cancelLabel={tI18nComplete.raw('text26b83994dca8')}
      confirmVariant="destructive"
      confirmIcon={<ArrowsClockwiseIcon className="size-3.5" />}
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
