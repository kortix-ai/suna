'use client';

/**
 * The strict `notification_center` gate controls session mute/watch actions.
 * Inbox surfaces also work when artifacts and artifact_comments are both on.
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

type FlagHolder = { experimental?: Partial<NonNullable<KortixProject['experimental']>> } | null | undefined;

/** The predicate of `useFeatureFlag`: the server said exactly `true`. */
export function notificationCenterOn(project: FlagHolder): boolean {
  return project?.experimental?.[NOTIFICATION_CENTER_FLAG] === true;
}

export function notificationInboxOn(project: FlagHolder): boolean {
  return notificationCenterOn(project) || (project?.experimental?.artifacts === true && project.experimental.artifact_comments === true);
}

/**
 * The flag for one project from the query cache: its detail, else a cached
 * project list that holds it. Undefined when neither holds it. Sends no request.
 */
export function cachedNotificationCenterAnswer(
  client: QueryClient | null,
  projectId: string | null | undefined,
): boolean | undefined {
  return cachedFlagAnswer(client, projectId, notificationCenterOn);
}

function cachedFlagAnswer(client: QueryClient | null, projectId: string | null | undefined, enabled: (project: FlagHolder) => boolean): boolean | undefined {
  if (!client || !projectId) return undefined;
  const detail = client.getQueryData<{ project?: FlagHolder }>(qk.project.detail(projectId));
  if (detail?.project) return enabled(detail.project);
  for (const [, data] of client.getQueriesData<unknown>({ queryKey: qk.projects.scope() })) {
    if (!Array.isArray(data)) continue;
    const project = data.find((row: { project_id?: unknown } | null) => row?.project_id === projectId);
    if (project) return enabled(project);
  }
  return undefined;
}

export function cachedNotificationInboxAnswer(client: QueryClient | null, projectId: string | null | undefined): boolean | undefined {
  return cachedFlagAnswer(client, projectId, notificationInboxOn);
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
function holdsFlagOn(query: Query, enabled: (project: FlagHolder) => boolean): boolean {
  const key = query.queryKey;
  const data: unknown = query.state.data;
  if (key[0] !== ROOT) return false;
  if (key[1] === LIST_SCOPE) return Array.isArray(data) && data.some(enabled);
  if (key[1] === DETAIL_SCOPE && key.length === 4 && key[3] === DETAIL) {
    return enabled((data as { project?: FlagHolder } | undefined)?.project);
  }
  return false;
}

/** True when any project in the query cache has the flag on. */
export function anyCachedNotificationCenter(client: QueryClient): boolean {
  return client.getQueryCache().getAll().some((query) => holdsFlagOn(query, notificationCenterOn));
}

export function anyCachedNotificationInbox(client: QueryClient): boolean {
  return client.getQueryCache().getAll().some((query) => holdsFlagOn(query, notificationInboxOn));
}

/**
 * A `useSyncExternalStore` subscription to the query cache, live only while
 * `active`. The cache reports synchronously, also when another component's
 * `useQuery` builds its query during render; the re-check waits for a
 * microtask so this component never updates in the middle of that render.
 */
function useCacheSubscription(client: QueryClient, active: boolean) {
  return useCallback(
    (onChange: () => void) => {
      if (!active) return () => {};
      let live = true;
      const unsubscribe = client.getQueryCache().subscribe(() => {
        queueMicrotask(() => {
          if (live) onChange();
        });
      });
      return () => {
        live = false;
        unsubscribe();
      };
    },
    [client, active],
  );
}

/** `anyCachedNotificationCenter`, reactive. Subscribes to the cache only while `scan`. */
function useAnyCachedNotificationCenter(client: QueryClient, scan: boolean): boolean {
  return useSyncExternalStore(
    useCacheSubscription(client, scan),
    () => scan && anyCachedNotificationCenter(client),
    () => false,
  );
}

function useAnyCachedNotificationInbox(client: QueryClient, scan: boolean): boolean {
  return useSyncExternalStore(useCacheSubscription(client, scan), () => scan && anyCachedNotificationInbox(client), () => false);
}

/** Is the notification center on for `projectId`, or, without one, for any cached project. */
export function useNotificationCenter(projectId?: string | null): boolean {
  const project = useFeatureFlag(projectId, NOTIFICATION_CENTER_FLAG).enabled;
  const anyProject = useAnyCachedNotificationCenter(useQueryClient(), !projectId);
  return projectId ? project : anyProject;
}

export function useNotificationInboxEnabled(projectId?: string | null): boolean {
  const center = useFeatureFlag(projectId, NOTIFICATION_CENTER_FLAG).enabled;
  const artifacts = useFeatureFlag(projectId, 'artifacts').enabled;
  const comments = useFeatureFlag(projectId, 'artifact_comments').enabled;
  const anyProject = useAnyCachedNotificationInbox(useQueryClient(), !projectId);
  return projectId ? center || (artifacts && comments) : anyProject;
}

/**
 * The inbox gate of `NotificationHost`, except while the
 * project's detail loads. Then a cached project list answers, else the
 * previous answer stays. So entering a flag-on project from `/projects` or
 * from another flag-on project does not unmount the host and subscribe Web
 * Push again. Only a loaded detail without the flag turns it off. A cold
 * load of a project page starts off.
 */
export function useNotificationHostGate(projectId?: string | null): boolean {
  const client = useQueryClient();
  // The global host sits outside the access boundary. Read the shell's detail
  // entry from the cache: no request for a potentially revoked project, and no
  // observer. An observer added a detail query without a queryFn (also for the
  // empty id of a page outside any project), and every refetch of it logged
  // "No queryFn was passed".
  const detail = useSyncExternalStore(
    useCacheSubscription(client, !!projectId),
    () => (projectId ? client.getQueryState<{ project?: FlagHolder }>(qk.project.detail(projectId)) : undefined),
    () => undefined,
  );
  const flag = {
    isLoading: !detail || detail.status === 'pending',
    enabled: notificationInboxOn(detail?.data?.project),
  };
  const anyProject = useAnyCachedNotificationInbox(client, !projectId);
  const [previous, setPrevious] = useState(false);
  let answer = anyProject;
  if (projectId) {
    answer = flag.isLoading
      ? (cachedNotificationInboxAnswer(client, projectId) ?? previous)
      : flag.enabled;
  }
  // The answer from an earlier render: React's derived-state pattern.
  if (answer !== previous) setPrevious(answer);
  return answer;
}
