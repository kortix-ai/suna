'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { COMPOSER_SHELL_CLASS } from '@/features/session/composer/composer';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from '@/features/session/session-body';
import { SessionLayout } from '@/features/session/session-layout';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { SessionStartStage } from '@kortix/sdk';

/**
 * Placeholder turns: the user bubble's width, then the assistant's line widths.
 * Fixed values, so the placeholder never shifts between renders.
 */
const TURNS = [
  { bubble: 'w-2/5', lines: ['w-full', 'w-11/12', 'w-3/5'] },
  { bubble: 'w-1/3', lines: ['w-full', 'w-4/5'] },
  { bubble: 'w-1/2', lines: ['w-full', 'w-11/12', 'w-full', 'w-2/3'] },
] as const;

/** The `Skeleton` primitive pads itself (`py-4`); these shapes set their own height. */
const SHAPE = 'py-0 motion-reduce:animate-none';

/**
 * A session being resumed, while its saved conversation is on its way.
 *
 * The control plane keeps a saved copy of every session's conversation and
 * answers in one round trip; the computer takes 5-240 s to wake. So a session
 * that has a saved copy opens on this — its header, skeleton turns, and the
 * composer's outline — and the conversation replaces it in one step. The boot
 * screen is only for a session with nothing to read (`resolveResumeOverlay`).
 *
 * Built from the geometry the real chat uses (`SessionLayout`, `SessionBodyRow`,
 * `SESSION_TRANSCRIPT_CLASS`, `COMPOSER_SHELL_CLASS`), so the crossfade into
 * `SessionChat` moves nothing but the content. The side panel still reports the
 * boot stage for anyone who opens it.
 */
export function SavedSessionSkeleton({
  projectId,
  sessionId,
  stage,
}: {
  projectId: string;
  /** The route's session id. */
  sessionId: string;
  stage: SessionStartStage;
}) {
  const t = useTranslations('sessionPage');
  return (
    <SessionLayout
      sessionId={sessionId}
      projectId={projectId}
      projectSessionId={sessionId}
      transient
      bootStage={stage === 'ready' ? null : stage}
    >
      <div className="bg-background relative flex h-full flex-col">
        {/* The header names the session from its cached row, as the chat's
            does; until the row answers it shows a placeholder for the name. */}
        <SessionSiteHeader sessionId={sessionId} sessionTitle="" />
        <SessionBodyRow transient>
          <div className="relative z-10 min-h-0 flex-1 overflow-hidden">
            <div
              role="status"
              aria-busy="true"
              aria-label={t('loadingConversation')}
              data-testid="saved-session-skeleton"
              className={SESSION_TRANSCRIPT_CLASS}
            >
              {TURNS.map((turn) => (
                <div key={turn.bubble} className="mt-12 first:mt-0">
                  <div className="flex justify-end">
                    <Skeleton className={cn(SHAPE, 'h-10 rounded-lg', turn.bubble)} />
                  </div>
                  <div className="mt-5 space-y-2.5">
                    {turn.lines.map((width, line) => (
                      <Skeleton key={`${turn.bubble}-${line}`} className={cn(SHAPE, 'h-3.5', width)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* The card's outline, on the rails of the docked composer: its height
              and the gap the agent row keeps below it. */}
          <div aria-hidden className={cn(COMPOSER_SHELL_CLASS, 'pb-8')}>
            <Skeleton className={cn(SHAPE, 'h-28 w-full rounded-xl')} />
          </div>
        </SessionBodyRow>
      </div>
    </SessionLayout>
  );
}
