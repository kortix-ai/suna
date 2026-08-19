'use client';

import { useQuery } from '@tanstack/react-query';

import { getProjectSession, type ProjectSession } from '../core/rest/projects-client';

import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * The ONLY way to read one Kortix session row.
 *
 * `qk.project.session(projectId, sessionId)` had three independent readers,
 * and the migration that unified their KEY left their CONTRACTS apart — the
 * narrower half of the same bug:
 *
 *   use-canonical-opencode-session.ts   staleTime: 10_000, showErrors: false
 *   session-files-panel.tsx             contract('inventory'), default errors
 *   session-changes-shared.tsx          contract('inventory'), default errors
 *
 * Both halves were mount-order dependent. `staleTime` is per-OBSERVER, so how
 * long the row stayed fresh depended on which surface happened to be mounted.
 * Worse, `queryFn` is per-ENTRY — TanStack keeps exactly one per cached query
 * and the first observer to mount installs it — so whether a failed read
 * raised a toast depended on whether the session page or the Changes panel
 * got there first.
 *
 * `showErrors: false` wins for every reader, deliberately. Each one's failure
 * path is already a silent, correct fallback that the UI never surfaces:
 * `resolveSessionPin` treats a missing pin as "still resolving" and the two
 * panels fall back to `base_ref = 'main'`. Nothing renders an error state or
 * offers a retry, so a toast is noise the user cannot act on. It is also
 * exactly the wrong moment for one — the session page issues this read during
 * boot and in the idle-stopped window, where a transient miss is expected and
 * self-heals. And `showErrors` is a client-side PRESENTATION flag: it does not
 * change the request or the response, so it cannot justify separate keys the
 * way `scope` does for `qk.project.sessions` (see `query-keys.ts`). One
 * entity, one entry, one fetcher.
 *
 * `enabled` stays per-call-site on purpose. It decides whether THIS surface
 * subscribes, not what the shared entry holds, so surfaces are free to
 * disagree — the session page skips the read entirely when `POST /start`
 * already handed it the pin.
 */
export function useProjectSession(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<ProjectSession>({
    queryKey: qk.project.session(projectId ?? '', sessionId ?? ''),
    queryFn: () =>
      getProjectSession(projectId as string, sessionId as string, { showErrors: false }),
    enabled: Boolean(projectId) && Boolean(sessionId) && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}
