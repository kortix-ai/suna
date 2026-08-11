import type { QueryClient } from '@tanstack/react-query';
import {
  getWorkspaceSandboxProviderTransition,
  type KortixWorkspace,
  type WorkspaceDetail,
  type WorkspaceSandboxProviderTransitionState,
  type UpdateWorkspaceSandboxProviderResult,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

/**
 * A provider-migration transition never changes again once it reaches one of
 * these statuses (mirrors the API's TERMINAL_TRANSITION_STATUSES) — plus the
 * immediate `noop`/`cleared` markers a transition row can carry. Polling stops
 * on any of them.
 */
export const SANDBOX_PROVIDER_TERMINAL_STATUSES = new Set([
  'activated',
  'failed',
  'superseded',
  'cancelled',
  'noop',
  'cleared',
]);

/** A missing/absent status (no live transition) is treated as terminal too. */
export function isSandboxProviderTransitionTerminal(status: string | null | undefined): boolean {
  return status == null || SANDBOX_PROVIDER_TERMINAL_STATUSES.has(status);
}

type CacheClient = Pick<QueryClient, 'setQueryData' | 'invalidateQueries'>;

/**
 * FIX-L: apply the PATCH /sandbox-provider result to the query cache.
 *
 * Writes the workspace caches ONLY for the immediate `kind:'workspace'` result. A
 * `kind:'preparation'` result is a durable TRANSITION object, not a workspace —
 * writing it into `qk.workspace.summary(id)` would corrupt the cached workspace
 * shape (it has no repo_url / metadata / experimental_features …). On
 * preparation we leave the workspace cache untouched and return `'preparation'`
 * so the caller polls the transition instead. Returns the result's kind.
 */
export function applySandboxProviderResult(
  queryClient: CacheClient,
  workspaceId: string,
  result: UpdateWorkspaceSandboxProviderResult,
): 'workspace' | 'preparation' {
  if (result.kind !== 'workspace') return 'preparation';
  // Strip the discriminant so the cached value is a pure KortixWorkspace.
  const { kind: _kind, ...workspace } = result;
  const cached = workspace as KortixWorkspace;
  queryClient.setQueryData(qk.workspace.summary(workspaceId), cached);
  queryClient.setQueryData<WorkspaceDetail | undefined>(qk.workspace.detail(workspaceId), (c) =>
    c ? { ...c, workspace: cached } : c,
  );
  queryClient.invalidateQueries({ queryKey: qk.workspace.detail(workspaceId) });
  // qk.workspaces.scope(), not the precise per-account form: restores the
  // reach the old bare workspaces-literal prefix match had — every account's
  // list, and the accountless slot the marketplace picker reads. A
  // sandbox-provider switch is rare — over-invalidating costs nothing.
  queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });
  return 'workspace';
}

export interface PollSandboxProviderTransitionOptions {
  /** Injected for tests; defaults to the SDK poll call. */
  fetchState?: (workspaceId: string) => Promise<WorkspaceSandboxProviderTransitionState>;
  /** Called once when polling stops (terminal status, no transition, or exhausted).
   *  `null` means the poll ended without a readable state (404/no-transition). */
  onSettled?: (state: WorkspaceSandboxProviderTransitionState | null) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Cooperative cancellation (e.g. component unmounted). */
  signal?: { aborted: boolean };
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * FIX-L: poll the durable provider-migration transition after a `kind:'preparation'`
 * switch. Bounded (maxAttempts) with exponential backoff; stops on a terminal
 * status, and treats a 404 / no-transition / any read error as terminal (nothing
 * left to poll). Never throws — surfaces progress via `onSettled`.
 */
export async function pollSandboxProviderTransition(
  workspaceId: string,
  opts: PollSandboxProviderTransitionOptions = {},
): Promise<WorkspaceSandboxProviderTransitionState | null> {
  const fetchState = opts.fetchState ?? getWorkspaceSandboxProviderTransition;
  const maxAttempts = opts.maxAttempts ?? 60;
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const maxDelayMs = opts.maxDelayMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: WorkspaceSandboxProviderTransitionState | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) return last;
    try {
      last = await fetchState(workspaceId);
    } catch {
      // 404 / no transition / transient read failure → nothing to keep polling.
      opts.onSettled?.(null);
      return null;
    }
    if (isSandboxProviderTransitionTerminal(last?.latest?.status)) {
      opts.onSettled?.(last);
      return last;
    }
    await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs));
  }
  opts.onSettled?.(last);
  return last;
}
