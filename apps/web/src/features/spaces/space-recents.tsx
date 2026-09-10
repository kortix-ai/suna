'use client';

/**
 * The sessions inside a space, under its composer — the same rows the
 * sidebar folder lists, laid out as a quiet "Recents" list (user,
 * 2026-09-06). Reads the SAME `qk.project.sessions(pid, 'visible')` entry the
 * sidebar polls, so it costs no request of its own.
 */
import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getSessionDisplayTitle,
  projectSessionsRefetchInterval,
  sessionLastActivityAt,
  sortSessionsByLastActivity,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { listProjectSessions, type ProjectSession } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useLocale, useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

const RECENTS_LIMIT = 12;

function formatDay(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function SpaceRecents({ projectId, slug }: { projectId: string; slug: string }) {
  const locale = useLocale();
  const tSpaces = useI18nTranslations('spaces');
  const sessionsQuery = useQuery({
    queryKey: qk.project.sessions(projectId, 'visible'),
    queryFn: () => listProjectSessions(projectId),
    refetchInterval: (q) =>
      projectSessionsRefetchInterval({
        sessions: q.state.data as ProjectSession[] | undefined,
        hasOpenSession: false,
      }),
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });
  const sessions = useMemo(
    () =>
      sortSessionsByLastActivity(
        (sessionsQuery.data ?? []).filter((session) => session.space === slug),
      ).slice(0, RECENTS_LIMIT),
    [sessionsQuery.data, slug],
  );

  return (
    // `px-4` keeps the list on the heading's and the composer's text rail
    // (see the heading's comment in welcome-body.tsx).
    <section className="flex w-full flex-col px-4" aria-label={tSpaces('recents.aria')}>
      <h2 className="text-muted-foreground text-sm font-medium">{tSpaces('recents.title')}</h2>
      {sessionsQuery.isLoading && !sessionsQuery.data ? (
        <div className="mt-3 space-y-3" aria-hidden>
          {['w-2/3', 'w-1/2', 'w-3/5'].map((width) => (
            <Skeleton key={width} className={`h-4 ${width}`} />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-muted-foreground/70 mt-2 text-sm">{tSpaces('recents.empty')}</p>
      ) : (
        <ul className="mt-1">
          {sessions.map((session) => (
            <li key={session.session_id} className="border-border border-b last:border-b-0">
              <HoverPrefetchLink
                href={`/projects/${projectId}/sessions/${session.session_id}`}
                className="hover:bg-hover -mx-2 flex h-11 items-center justify-between gap-4 rounded-md px-2 text-sm transition-colors"
              >
                <span className="text-foreground min-w-0 flex-1 truncate">
                  {getSessionDisplayTitle(session)}
                </span>
                <time
                  dateTime={sessionLastActivityAt(session)}
                  className="text-muted-foreground shrink-0 text-xs tabular-nums"
                >
                  {formatDay(sessionLastActivityAt(session), locale)}
                </time>
              </HoverPrefetchLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
