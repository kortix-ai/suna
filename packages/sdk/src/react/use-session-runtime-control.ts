import { useQuery, useQueryClient } from '@tanstack/react-query';

import { qk } from './query-keys';
import type { RuntimeControlSnapshot } from './session-stream-routing';

/**
 * The live `kortix.control.runtime` box view for a session — the control
 * plane's `sandbox_status` / `waking`, pushed over `/events` and cached by the
 * stream sink (`use-session-stream`). This is the frame the client used to
 * DROP; consuming it is what lets connection/readiness ride the stream instead
 * of a poll.
 *
 * CACHE-ONLY. There is no endpoint and no fetch: the `queryFn` only reads back
 * what the stream wrote (a plain queryFn-less `useQuery` throws "No queryFn").
 * `undefined` until the first frame lands — the caller falls back to the row
 * status, and an absent frame is NEVER read as "stopped".
 *
 * Feed the result to `projectSessionConnection` via `sandboxStatusToLifecycle`.
 */
export function useSessionRuntimeControl(
  projectId: string | undefined,
  sessionId: string | undefined,
): RuntimeControlSnapshot | undefined {
  const queryClient = useQueryClient();
  const enabled = !!projectId && !!sessionId;
  const key = qk.project.sessionRuntimeControl(projectId ?? '', sessionId ?? '');
  const { data } = useQuery<RuntimeControlSnapshot | null>({
    queryKey: key,
    // Reads back the stream-written cache; never hits the network. Re-renders
    // when the stream's `setQueryData` for this key lands a new frame.
    queryFn: () => queryClient.getQueryData<RuntimeControlSnapshot>(key) ?? null,
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? undefined;
}
