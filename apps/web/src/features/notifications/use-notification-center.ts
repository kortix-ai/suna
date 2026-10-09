'use client';

/**
 * The `notification_center` project flag on the web (KRTX-1742). It is off by
 * default. A project with the flag off behaves as before the notification
 * center: no bell, no inbox request, no Web Push subscription, no mute item,
 * and the four per-browser kind switches in Settings > Notifications.
 *
 * - With a project id: `useFeatureFlag`, fail-closed, on the shared
 *   `qk.project.detail(id)` entry that the project shell reads.
 * - Without one (`/projects`, `/new`, standalone `/settings`): on when any
 *   project already in this client's query cache has the flag on. The scan
 *   reads the cached project details and project lists. It sends no request,
 *   so a cold load of such a page with nothing cached reads off.
 * - `NotificationHost` uses `useNotificationHostGate`: while a project's
 *   detail loads, a cached project list or its previous answer decides.
 */

import type { KortixProject } from '@kortix/sdk';
import { qk, useFeatureFlag } from '@kortix/sdk/react';
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';

export const NOTIFICATION_CENTER_FLAG = 'notification_center';

type FlagHolder = Pick<KortixProject, 'experimental'> | null | undefined;

/** The predicate of `useFeatureFlag`: the server said exactly `true`. */
export function notificationCenterOn(project: FlagHolder): boolean {
  return project?.experimental?.[NOTIFICATION_CENTER_FLAG] === true;
}

/**
 * The flag for one project from the query cache: its detail, else a cached
 * project list that holds it. Undefined when neither holds it. Sends no request.
 */
export function cachedNotificationCenterAnswer(
  client: QueryClient | null,
  projectId: string | null | undefined,
): boolean | undefined {
  if (!client || !projectId) return undefined;
  const detail = client.getQueryData<{ project?: FlagHolder }>(qk.project.detail(projectId));
  if (detail?.project) return notificationCenterOn(detail.project);
  for (const [, data] of client.getQueriesData<unknown>({ queryKey: qk.projects.scope() })) {
    if (!Array.isArray(data)) continue;
    const project = data.find((row: { project_id?: unknown } | null) => row?.project_id === projectId);
    if (project) return notificationCenterOn(project);
  }
  return undefined;
}

/** The flag for one project from the query cache. False when nothing cached holds it. */
export function cachedNotificationCenter(
  client: QueryClient | null,
  projectId: string | null | undefined,
): boolean {
  return cachedNotificationCenterAnswer(client, projectId) === true;
}

const [ROOT, LIST_SCOPE] = qk.projects.scope();
const [, DETAIL_SCOPE, , DETAIL] = qk.project.detail('');

/** A project-list entry or a project-detail entry that holds a project with the flag on. */
function holdsFlagOn(query: Query): boolean {
  const key = query.queryKey;
  const data: unknown = query.state.data;
  if (key[0] !== ROOT) return false;
  if (key[1] === LIST_SCOPE) return Array.isArray(data) && data.some(notificationCenterOn);
  if (key[1] === DETAIL_SCOPE && key.length === 4 && key[3] === DETAIL) {
    return notificationCenterOn((data as { project?: FlagHolder } | undefined)?.project);
  }
  return false;
}

/** True when any project in the query cache has the flag on. */
export function anyCachedNotificationCenter(client: QueryClient): boolean {
  return client.getQueryCache().getAll().some(holdsFlagOn);
}

/** `anyCachedNotificationCenter`, reactive. Subscribes to the cache only while `scan`. */
function useAnyCachedNotificationCenter(client: QueryClient, scan: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => (scan ? client.getQueryCache().subscribe(onChange) : () => {}),
    [client, scan],
  );
  return useSyncExternalStore(
    subscribe,
    () => scan && anyCachedNotificationCenter(client),
    () => false,
  );
}

/** Is the notification center on for `projectId`, or, without one, for any cached project. */
export function useNotificationCenter(projectId?: string | null): boolean {
  const project = useFeatureFlag(projectId, NOTIFICATION_CENTER_FLAG).enabled;
  const anyProject = useAnyCachedNotificationCenter(useQueryClient(), !projectId);
  return projectId ? project : anyProject;
}

/**
 * The gate of `NotificationHost`: `useNotificationCenter`, except while the
 * project's detail loads. Then a cached project list answers, else the
 * previous answer stays. So entering a flag-on project from `/projects` or
 * from another flag-on project does not unmount the host and subscribe Web
 * Push again. Only a loaded detail without the flag turns it off. A cold
 * load of a project page starts off.
 */
export function useNotificationHostGate(projectId?: string | null): boolean {
  const flag = useFeatureFlag(projectId, NOTIFICATION_CENTER_FLAG);
  const client = useQueryClient();
  const anyProject = useAnyCachedNotificationCenter(client, !projectId);
  const [previous, setPrevious] = useState(false);
  let answer = anyProject;
  if (projectId) {
    answer = flag.isLoading
      ? (cachedNotificationCenterAnswer(client, projectId) ?? previous)
      : flag.enabled;
  }
  // The answer from an earlier render: React's derived-state pattern.
  if (answer !== previous) setPrevious(answer);
  return answer;
}
