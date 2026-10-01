'use client';

import { Button } from '@/components/ui/button';
import { dismissToast, infoToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { newlyAwaiting, askedYouAsker } from '@/features/workspace/project-sidebar/asked-you';
import type { ProjectSession } from '@kortix/sdk';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

const QUESTION_PREVIEW_CHARS = 120;
const TOAST_DURATION_MS = 8000;

/**
 * One calm toast when a new conversation starts waiting on the viewer while the
 * app is open. The first successful read is the baseline: what already waited
 * when the page loaded is in the section, not in a toast. A session is told once
 * per page load; answering it and being asked again is a new ask and stays quiet
 * until a reload, by design.
 */
export function useAskedYouArrival({
  projectId,
  sessions,
  loaded,
  viewerId,
}: {
  projectId: string;
  sessions: readonly ProjectSession[];
  loaded: boolean;
  viewerId: string | null;
}) {
  const t = useTranslations('sidebar.askedYou');
  const seen = useRef<Set<string> | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!loaded) return;
    if (seen.current === null) {
      seen.current = new Set(newlyAwaiting(sessions, viewerId, new Set()).map((s) => s.session_id));
      return;
    }
    for (const session of newlyAwaiting(sessions, viewerId, seen.current)) {
      seen.current.add(session.session_id);
      // Already looking at it: the card in front of them says the same thing.
      if (pathname?.includes(session.session_id)) continue;
      const asker = askedYouAsker(session);
      const question = (session.name ?? '').slice(0, QUESTION_PREVIEW_CHARS);
      const toastId = `asked-you-${session.session_id}`;
      infoToast(asker ? t('arrival', { name: asker }) : t('arrivalUnknown'), {
        id: toastId,
        duration: TOAST_DURATION_MS,
        description: question || undefined,
        button: (
          <Button asChild size="sm" variant="outline">
            <Link
              href={`/projects/${projectId}/sessions/${session.session_id}`}
              onClick={() => dismissToast(toastId)}
            >
              {t('open')}
            </Link>
          </Button>
        ),
      });
    }
  }, [loaded, sessions, viewerId, projectId, t, pathname]);
}
