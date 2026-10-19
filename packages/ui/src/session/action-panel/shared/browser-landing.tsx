'use client';

/**
 * The session browser's landing (KRTX-2441, Paper board "09 · Timeline"): one
 * list of everything the browser can open, grouped Today / Earlier / Not opened
 * yet. A project App appears once — its last visit places it in time, and an
 * App never opened sits under "Not opened yet" with its status. Recents that
 * are not Apps (sandbox ports, web pages) fill the rest of the timeline.
 *
 * It replaced an Apps grid stacked over a separate Recents list, which showed
 * every opened App twice.
 */

import { AppPreview } from '../../../shared/features/apps/app-preview';
import { appCan, appStatus, gridApps } from '../../../shared/features/apps/app-shared';
import { appForUrl } from '../../../shared/features/apps/app-in-browser';
import { useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../shared/lib/project-actions';
import { useProjectCan } from '../../../shared/lib/use-project-can';
import { cn } from '../../../lib/utils';
import { recentDisplayLabel, type BrowserRecent } from '../../../shared/stores/browser-recents-store';
import type { App } from '@kortix/sdk';
import { useAppAccess, useProjectApps } from '@kortix/sdk/react';
import { useMemo, type ReactNode } from 'react';

export interface LandingRow {
  key: string;
  url: string;
  label: string;
  /** A sandbox port or web URL, set in mono. */
  mono: boolean;
  thumb: 'app' | 'app-idle' | 'app-draft' | 'url';
  /** Last visit, ms epoch. Absent for an App never opened. */
  visitedAt?: number;
  app?: App;
}

export interface LandingGroups {
  today: LandingRow[];
  earlier: LandingRow[];
  notOpened: LandingRow[];
}

function appThumb(app: App): LandingRow['thumb'] {
  if (!app.active_deployment_id) return 'app-draft';
  return app.desired_state === 'running' || app.hosting_type === 'static' ? 'app' : 'app-idle';
}

/**
 * Pure: merge the project's Apps into the recents timeline. An App's visits
 * collapse to its latest one (the URL of that visit, so a deep path survives).
 */
export function browserLandingGroups(apps: readonly App[], recents: readonly BrowserRecent[], now: number): LandingGroups {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const seenApps = new Set<string>();
  const groups: LandingGroups = { today: [], earlier: [], notOpened: [] };

  for (const recent of [...recents].sort((a, b) => b.visitedAt - a.visitedAt)) {
    const app = appForUrl(apps, recent.url);
    if (app && seenApps.has(app.app_id)) continue;
    if (app) seenApps.add(app.app_id);
    const row: LandingRow = app
      ? { key: app.app_id, url: recent.url, label: app.name, mono: false, thumb: appThumb(app), visitedAt: recent.visitedAt, app }
      : { key: recent.url, url: recent.url, label: recentDisplayLabel(recent.url), mono: true, thumb: 'url', visitedAt: recent.visitedAt };
    (recent.visitedAt >= startOfToday ? groups.today : groups.earlier).push(row);
  }

  for (const app of apps) {
    if (seenApps.has(app.app_id)) continue;
    groups.notOpened.push({ key: app.app_id, url: app.url, label: app.name, mono: false, thumb: appThumb(app), app });
  }
  return groups;
}

function visitLabel(visitedAt: number, now: number, yesterday: string): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (visitedAt >= startOfToday) {
    return new Date(visitedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (visitedAt >= startOfToday - 86_400_000) return yesterday;
  return new Date(visitedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A row's thumbnail: the App itself, live, through the same pooled frame the
 * Apps page cards use (the project shell preloads it, so this costs no extra
 * load). A port, an undeployed App, or an App the viewer may not open keeps
 * a plain tile.
 */
function LandingThumb({ projectId, row }: { projectId?: string; row: LandingRow }) {
  const app = row.app;
  const live =
    !!app && !!app.active_deployment_id && appCan(app, 'preview') && app.viewer_can_access !== false;
  const access = useAppAccess(projectId, live ? app!.app_id : null, { policy: false, session: live });
  const url = access.session.data?.url ?? null;
  return (
    <span
      aria-hidden
      className={cn(
        'relative h-6.5 w-10 shrink-0 overflow-hidden rounded-sm',
        row.thumb === 'url' && 'bg-muted',
        (row.thumb === 'app' || row.thumb === 'app-idle') && 'bg-card border-muted-foreground border',
        row.thumb === 'app-idle' && 'opacity-60',
        row.thumb === 'app-draft' && 'border-muted-foreground border border-dashed',
      )}
    >
      {app && live && url ? (
        <AppPreview
          app={app}
          url={url}
          accessError={false}
          interactive={false}
          className="pointer-events-none absolute inset-0 aspect-auto"
        />
      ) : null}
    </span>
  );
}

export function BrowserLanding({
  projectId,
  recents,
  onOpen,
  empty = null,
}: {
  projectId?: string;
  /** The recents this surface can open (Easy filters to ports and Apps). */
  recents: readonly BrowserRecent[];
  onOpen: (url: string) => void;
  /** Shown when there is nothing to list. */
  empty?: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tProjectSelector = useTranslations('projectSelector');
  const apps = useProjectApps(projectId);
  const canAdmin = useProjectCan(projectId ?? '', PROJECT_ACTIONS.PROJECT_APP_ADMIN).allowed === true;
  const now = Date.now();
  const groups = useMemo(
    () => browserLandingGroups(apps.data ? gridApps(apps.data, canAdmin) : [], recents, now),
    // `now` moves every render; the grouping only needs the day it falls in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apps.data, canAdmin, recents],
  );

  if (apps.isLoading) return null;
  if (!groups.today.length && !groups.earlier.length && !groups.notOpened.length) return <>{empty}</>;

  const yesterday = tI18nComplete.raw('text566181254b29');
  const sections: Array<{ title: string; rows: LandingRow[] }> = [
    { title: tI18nComplete.raw('text2b065c7c9ce4'), rows: groups.today },
    { title: tI18nComplete.raw('texte10ae9907401'), rows: groups.earlier },
    { title: tProjectSelector.raw('neverOpened'), rows: groups.notOpened },
  ];

  return (
    <div className="flex flex-col gap-5 px-8 py-6">
      {sections
        .filter((section) => section.rows.length)
        .map((section) => (
          <section key={section.title} className="flex flex-col gap-0.5">
            <h3 className="text-muted-foreground px-2 pb-1.5 text-xs font-medium">
              {section.title}
            </h3>
            {section.rows.map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => onOpen(row.url)}
                className="hover:bg-foreground/5 focus-visible:bg-foreground/5 flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors focus-visible:outline-none"
              >
                <LandingThumb projectId={projectId} row={row} />
                <span
                  className={cn(
                    'text-foreground min-w-0 flex-1 truncate',
                    row.mono ? 'font-mono text-xs' : 'text-sm font-medium',
                  )}
                >
                  {row.label}
                </span>
                <span className="text-muted-foreground w-24 shrink-0 truncate text-right text-xs">
                  {row.visitedAt !== undefined
                    ? visitLabel(row.visitedAt, now, yesterday)
                    : row.app
                      ? appStatus(row.app, tI18nComplete).label
                      : null}
                </span>
              </button>
            ))}
          </section>
        ))}
    </div>
  );
}
