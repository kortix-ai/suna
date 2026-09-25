'use client';

/**
 * "This workspace started from the project's previous repository."
 *
 * Shown on a session whose workspace predates a repository replacement. The
 * session is NOT frozen: it starts, it runs the project's current config
 * release, and it converges like any other session. What is still true of it
 * is PHYSICAL — the clone on its disk came from the old repository, while
 * `origin` now resolves to the new one. The two histories are unrelated, so a
 * push without a rebase is refused by Git itself. That is the only thing this
 * notice is about.
 *
 * Built to the same shape as the header's changes popover
 * (`SessionChangesIndicator`): a tile, a title, one line of explanation, and
 * the one thing you can do about it. It floats under the session header
 * instead of pushing the whole route down as a full-width strip, and it can be
 * dismissed. The dismissal is a per-viewer convenience, so it lives in
 * `localStorage` and falls back to "shown" when storage is unavailable.
 *
 *     [tile]  This session is out of date                 [x]
 *             The project changed after this session ...
 *     ----------------------------------------------------------
 *                                          [Update to latest]
 */

import { ArrowsClockwiseIcon, XIcon } from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { createContext, useCallback, useContext, useState } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { useSessionBaseRef } from '@/features/session/session-changes-shared';
import { useTranslations } from '@/i18n/use-translations';
import { useChatSendStore } from '@/stores/chat-send-store';

function repositoryGeneration(metadata: Record<string, unknown> | null | undefined): string | null {
  const generation = metadata?.repository_generation;
  return typeof generation === 'string' && generation.length > 0 ? generation : null;
}

export function sessionUsesPreviousRepository(
  projectMetadata: Record<string, unknown> | null | undefined,
  sessionMetadata: Record<string, unknown> | null | undefined,
): boolean {
  const current = repositoryGeneration(projectMetadata);
  return current !== null && repositoryGeneration(sessionMetadata) !== current;
}

/**
 * The agent-facing instruction behind "Update to latest". English on purpose:
 * it is a prompt for the model, not UI copy.
 *
 * Order matters. Committing and tagging a backup ref come first, so no path
 * through the remaining steps can lose work. The shared-history check picks
 * rebase or re-apply, because a replaced repository often has no common
 * ancestor with the old one and `git rebase` would replay its entire history.
 */
export function previousRepositoryUpdatePrompt(baseRef: string): string {
  return [
    "This project's repository was replaced. This workspace was cloned from the previous repository, but `origin` now points to the current repository. Move this session's work onto the current repository:",
    '',
    '1. Run `git status`. Commit any uncommitted work on the current branch so nothing is lost.',
    '2. Create a backup ref: `git branch -f backup/previous-repository HEAD`.',
    `3. Run \`git fetch origin\`, then \`git merge-base HEAD origin/${baseRef}\`.`,
    `4. If a merge base exists, rebase this session's own commits onto \`origin/${baseRef}\`.`,
    `5. If no merge base exists, reset this branch to \`origin/${baseRef}\` and re-apply only the files this session changed. Take them from \`backup/previous-repository\`.`,
    '6. Resolve conflicts carefully. Do not push.',
    '',
    'Then report which commits or files moved over, and any conflict you could not resolve.',
  ].join('\n');
}

/** Whether the route decided this session needs the notice. Default: no. */
const PreviousRepositoryNoticeContext = createContext(false);
export const PreviousRepositoryNoticeProvider = PreviousRepositoryNoticeContext.Provider;

const DISMISS_KEY_PREFIX = 'kortix:previous-repository-notice-dismissed:';

function readDismissed(projectSessionId: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY_PREFIX + projectSessionId) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(projectSessionId: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY_PREFIX + projectSessionId, '1');
  } catch {
    // Storage blocked: the notice stays hidden for this mount only.
  }
}

/**
 * Mounted by the session header, positioned against it. Renders nothing unless
 * the route provided `true` and this viewer has not dismissed it.
 */
export function PreviousRepositoryNotice() {
  const visible = useContext(PreviousRepositoryNoticeContext);
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();
  if (!visible || !projectSessionId) return null;
  // Keyed so a client-side hop to another session re-reads its own dismissal.
  return (
    <PreviousRepositoryNoticeCard
      key={projectSessionId}
      projectId={projectId}
      projectSessionId={projectSessionId}
    />
  );
}

function PreviousRepositoryNoticeCard({
  projectId,
  projectSessionId,
}: {
  projectId: string;
  projectSessionId: string;
}) {
  const t = useTranslations('sessionPage.previousRepository');
  const baseRef = useSessionBaseRef(projectId, projectSessionId);
  const sendToSession = useChatSendStore((s) => s.sendToSession);
  const [dismissed, setDismissed] = useState(() => readDismissed(projectSessionId));
  const [updating, setUpdating] = useState(false);

  const dismiss = useCallback(() => {
    writeDismissed(projectSessionId);
    setDismissed(true);
  }, [projectSessionId]);

  const update = useCallback(async () => {
    if (updating) return;
    setUpdating(true);
    try {
      // The chat registers the project session id as an alias, so this reaches
      // the root conversation whichever sub-session is on screen.
      await sendToSession(projectSessionId, previousRepositoryUpdatePrompt(baseRef));
      successToast(t('updateSent'));
      dismiss();
    } catch (err) {
      errorToast(err instanceof Error ? err.message : t('updateFailed'));
    } finally {
      setUpdating(false);
    }
  }, [baseRef, dismiss, projectSessionId, sendToSession, t, updating]);

  if (dismissed) return null;

  return (
    <section
      role="status"
      aria-label={t('title')}
      className="bg-popover border-border absolute top-full right-4 mt-1 w-96 max-w-[calc(100%-2rem)] overflow-hidden rounded-md border shadow-md"
    >
      <div className="border-border flex items-start gap-3 border-b py-3.5 pr-2 pl-4">
        <span className="bg-kortix-orange/15 text-kortix-orange flex size-9 shrink-0 items-center justify-center rounded-sm">
          <ArrowsClockwiseIcon className="size-5" weight="bold" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-foreground text-sm font-medium">{t('title')}</h3>
          <p className="text-muted-foreground text-xs">{t('message')}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={dismiss}
          aria-label={t('dismiss')}
          className="text-muted-foreground shrink-0"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2.5">
        <Hint side="bottom" sideOffset={4} delayDuration={300} label={t('updateHint')}>
          <Button size="sm" onClick={update} disabled={updating}>
            {updating ? <Loading className="size-3.5 shrink-0" /> : null}
            {updating ? t('updating') : t('update')}
          </Button>
        </Hint>
      </div>
    </section>
  );
}
