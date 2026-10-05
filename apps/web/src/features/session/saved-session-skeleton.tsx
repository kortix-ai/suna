'use client';

import { COMPOSER_SHELL_CLASS } from '@/features/session/composer/composer';
import { SessionSiteHeader } from '@/features/session/header/session-site-header';
import { SavedSessionSkeletonRows, SkeletonBar } from '@/features/session/saved-session-skeleton-rows';
import { savedSessionSkeletonShape } from '@/features/session/saved-session-skeleton-shape';
import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from '@/features/session/session-body';
import { SessionLayout } from '@/features/session/session-layout';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { SessionStartStage } from '@kortix/sdk';
import { useMemo } from 'react';

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
 *
 * The turns are this session's own (`savedSessionSkeletonShape`, seeded by the
 * session id), so two sessions do not open on the same picture, and the route's
 * loading boundary and the page draw identical rows. One pulse travels down
 * them, ending on the composer.
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
  const shape = useMemo(() => savedSessionSkeletonShape(sessionId), [sessionId]);
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
              <SavedSessionSkeletonRows shape={shape} />
            </div>
          </div>
          {/* The card's outline, on the rails of the docked composer: its height
              and the gap the agent row keeps below it. */}
          <div aria-hidden className={cn(COMPOSER_SHELL_CLASS, 'pb-8')}>
            <SkeletonBar
              phase={shape.composerPhase}
              phases={shape.phases}
              className="h-28 w-full rounded-xl"
            />
          </div>
        </SessionBodyRow>
      </div>
    </SessionLayout>
  );
}
