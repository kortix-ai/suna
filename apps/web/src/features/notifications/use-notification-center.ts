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
 */

import type { KortixProject } from '@kortix/sdk';
import { qk, useFeatureFlag } from '@kortix/sdk/react';
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

export const NOTIFICATION_CENTER_FLAG = 'notification_center';

type FlagHolder = Pick<KortixProject, 'experimental'> | null | undefined;

/** The predicate of `useFeatureFlag`: the server said exactly `true`. */
export function notificationCenterOn(project: FlagHolder): boolean {
  return project?.experimental?.[NOTIFICATION_CENTER_FLAG] === true;
}

/** The flag for one project, from its cached detail. Sends no request; false when nothing is cached. */
export function cachedNotificationCenter(
  client: QueryClient | null,
  projectId: string | null | undefined,
): boolean {
  if (!client || !projectId) return false;
  const detail = client.getQueryData<{ project?: FlagHolder }>(qk.project.detail(projectId));
  return notificationCenterOn(detail?.project);
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

/** Is the notification center on for `projectId`, or, without one, for any cached project. */
export function useNotificationCenter(projectId?: string | null): boolean {
  const project = useFeatureFlag(projectId, NOTIFICATION_CENTER_FLAG).enabled;
  const client = useQueryClient();
  const scan = !projectId;
  const subscribe = useCallback(
    (onChange: () => void) => (scan ? client.getQueryCache().subscribe(onChange) : () => {}),
    [client, scan],
  );
  const anyProject = useSyncExternalStore(
    subscribe,
    () => scan && anyCachedNotificationCenter(client),
    () => false,
  );
  return scan ? anyProject : project;
}
