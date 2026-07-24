import type { QueryClient } from '@tanstack/react-query';
import {
  getProjectSandboxProviderTransition,
  type KortixProject,
  type ProjectDetail,
  type SandboxProviderTransitionState,
  type UpdateProjectSandboxProviderResult,
} from '@kortix/sdk';

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
 * Writes the project caches ONLY for the immediate `kind:'project'` result. A
 * `kind:'preparation'` result is a durable TRANSITION object, not a project —
 * writing it into `['project', id]` would corrupt the cached project shape (it
 * has no repo_url / metadata / experimental_features …). On preparation we leave
 * the project cache untouched and return `'preparation'` so the caller polls the
 * transition instead. Returns the result's kind.
 */
export function applySandboxProviderResult(
  queryClient: CacheClient,
  projectId: string,
  result: UpdateProjectSandboxProviderResult,
): 'project' | 'preparation' {
  if (result.kind !== 'project') return 'preparation';
  // Strip the discriminant so the cached value is a pure KortixProject.
  const { kind: _kind, ...project } = result;
  const cached = project as KortixProject;
  queryClient.setQueryData(['project', projectId], cached);
  queryClient.setQueryData<ProjectDetail | undefined>(['project-detail', projectId], (c) =>
    c ? { ...c, project: cached } : c,
  );
  queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
  queryClient.invalidateQueries({ queryKey: ['projects'] });
  return 'project';
}

export interface PollSandboxProviderTransitionOptions {
  /** Injected for tests; defaults to the SDK poll call. */
  fetchState?: (projectId: string) => Promise<SandboxProviderTransitionState>;
  /** Called once when polling stops (terminal status, no transition, or exhausted).
   *  `null` means the poll ended without a readable state (404/no-transition). */
  onSettled?: (state: SandboxProviderTransitionState | null) => void;
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
  projectId: string,
  opts: PollSandboxProviderTransitionOptions = {},
): Promise<SandboxProviderTransitionState | null> {
  const fetchState = opts.fetchState ?? getProjectSandboxProviderTransition;
  const maxAttempts = opts.maxAttempts ?? 60;
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const maxDelayMs = opts.maxDelayMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: SandboxProviderTransitionState | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) return last;
    try {
      last = await fetchState(projectId);
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
