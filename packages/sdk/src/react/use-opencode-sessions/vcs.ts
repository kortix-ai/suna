'use client';

import { useQuery } from '@tanstack/react-query';

import type { VcsFileDiff } from '@opencode-ai/sdk/v2/client';

import { getClient } from '../../core/runtime/client';
import { readDaemonOpencode } from '../../core/runtime/daemon-read';
import { useCurrentRuntime } from '../use-current-runtime';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap } from './shared';

// Re-exported so a host reads the diff shape from `@kortix/sdk`, never from
// `@opencode-ai/sdk` (see AGENTS.md — hosts never import the opencode SDK).
export type { VcsFileDiff };

/**
 * Which set of changes `/vcs/diff` describes.
 *
 * - `git` — the WORKING TREE only. Goes to zero the moment the agent commits.
 * - `branch` — the working tree PLUS every commit this branch carries over the
 *   repository's default branch. This is the "what has this version changed
 *   that is not in main yet" set, and it is the one the Changes surface means.
 */
export type VcsDiffMode = 'git' | 'branch';

/**
 * The session's file changes, as ONE array with ONE query key.
 *
 * Every Changes surface (the tab badge, the header chip, the diff panel) must
 * read this hook. React Query dedupes by key, so they cannot disagree: a badge
 * reading "32" above a body reading "no changes yet" is not possible when both
 * derive from the same cache entry.
 *
 * `session.diff` — the endpoint the diff panel used to read — answers a
 * different question ("what did THIS user message change"), which is why a
 * fresh session with no user message returned `[]` while `git status` reported
 * a dirty tree.
 */
export function useOpenCodeVcsDiff(
  mode: VcsDiffMode = 'branch',
  options?: { enabled?: boolean },
) {
  const runtimeReady = useOpenCodeRuntimeReady();
  // Subscribe to the active sandbox so the key recomputes the instant the
  // runtime switches — session A's diff must never paint under session B.
  const serverId = useCurrentRuntime((s) => s.sandboxId) ?? undefined;
  return useQuery<VcsFileDiff[]>({
    queryKey: opencodeKeys.vcsDiff(mode, serverId),
    queryFn: async () => {
      // The `/kortix/opencode/vcs-diff` daemon passthrough, never the raw
      // OpenCode `/vcs/diff` proxy — the web client speaks only `/kortix/*`.
      const data = await readDaemonOpencode<VcsFileDiff[]>('vcs-diff', { mode: String(mode) });
      return Array.isArray(data) ? data : [];
    },
    enabled: runtimeReady && options?.enabled !== false,
    // Agent edits arrive as SSE events that invalidate `vcsDiffAll()`, so the
    // panel does not depend on a poll; this only bounds refetch churn from
    // remounts while a turn is running.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
