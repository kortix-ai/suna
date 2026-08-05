'use client';

/**
 * "Is this session still running the agent I edited?" — answered in the UI.
 *
 * A session's agent behaviour is compiled from git ONCE, at provision, and
 * frozen into its sandbox environment. Merge a change to an agent and every
 * session already open keeps running the old one, silently and indefinitely.
 * Until now the only way to find out was `kortix sessions reload <id> --status`
 * in a terminal, which means most people never found out at all.
 *
 * The whole design turns on ONE thing: `stale` is tri-state. `true` behind,
 * `false` current, and `null` **could not tell** — an unreachable sandbox, or a
 * project with no compiled config to compare against. Collapsing `null` into
 * "up to date" would make this feature actively worse than nothing, because it
 * would answer a question it never asked.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  getProjectSessionConfigState,
  reloadProjectSessionConfig,
  type SessionConfigState,
  type SessionReloadResult,
  sessionStartKey,
} from '@kortix/sdk';
import { clearRuntimeEnsureGuard } from '@kortix/sdk/react';

/**
 * How long a freshness answer is trusted before a window-focus refetch will
 * re-ask.
 *
 * Named, exported and asserted in tests because its VALUE is the bug. React
 * Query skips a focus refetch while the cached value is still fresh, so this
 * constant is what decides whether "edit an agent file, tab back to the session"
 * shows anything at all. At the 5 minutes it used to be, it showed nothing, and
 * a full page reload was the only thing that worked — a reload wipes the cache
 * instead of revalidating, which is why it looked like the feature worked.
 *
 * Raise this and you silently switch the feature off for the flow people
 * actually use.
 */
export const CONFIG_FRESHNESS_STALE_TIME_MS = 30_000;

export function sessionConfigKey(projectId?: string, sessionId?: string) {
  return ['session-config', projectId ?? '', sessionId ?? ''] as const;
}

/**
 * What, if anything, the UI should say.
 *
 * Deliberately NOT a boolean and deliberately without an `ok` member: the only
 * two things worth rendering are "you are behind" and "we could not check".
 * Everything else — current, still loading, nothing to compare, box asleep —
 * collapses to `hidden`, because a session that is fine should cost zero chrome.
 */
export type SessionConfigNotice =
  | { kind: 'hidden' }
  | { kind: 'stale'; running: string; latest: string }
  | { kind: 'unverified' };

/**
 * Pure, so the branch order is testable without a DOM or a network.
 *
 * The order matters and mirrors the CLI's. `stale` is consulted BEFORE the
 * reachability and compile checks, because when the server could answer, its
 * answer is the answer; the later branches only exist to explain a `null`.
 */
export function sessionConfigNotice(state: SessionConfigState | undefined): SessionConfigNotice {
  if (!state) return { kind: 'hidden' };
  if (state.stale === true) {
    return {
      kind: 'stale',
      // Both are non-null whenever `stale` is a boolean — that is what
      // `isConfigStale` guarantees server-side. The fallbacks keep a contract
      // change from rendering "undefined" at a user.
      running: state.running_etag ?? '—',
      latest: state.latest_etag ?? '—',
    };
  }
  if (state.stale === false) return { kind: 'hidden' };
  // From here down `stale` is null and we are deciding whether the user can do
  // anything about it.
  //
  // A sleeping sandbox is not a problem to report: nothing is running the wrong
  // config because nothing is running. It wakes with the latest.
  if (!state.sandbox_reachable) return { kind: 'hidden' };
  // Nothing compiles — a v1 `kortix.toml` project. The concept does not apply,
  // so saying anything would invent a problem.
  if (state.latest_etag === null) return { kind: 'hidden' };
  // The box is up and the config compiles, but the box did not say what it is
  // running: a sandbox provisioned before this shipped. Worth surfacing, since
  // a reload is exactly the fix.
  return { kind: 'unverified' };
}

/**
 * A `reason` is internal wording chosen for a CLI. One of them is a raw thrown
 * exception message. Map every known value; never render one directly.
 */
export function reloadNotAppliedCopy(reason?: string): string {
  switch (reason) {
    case 'no reachable sandbox':
    case 'no active sandbox':
      return "This session's sandbox isn't running. Start the session, then reload.";
    case 'no compiled agent config':
      return 'This project has no compiled agent config to load.';
    case 'sandbox has no service key':
    case 'no env snapshot':
      return "Couldn't reach this session's runtime. Try again in a moment.";
    case 'agent config unchanged':
      return 'Already running the latest config.';
    default:
      return "Reload didn't apply. Try again in a moment.";
  }
}

/** The two refusals the server distinguishes, keyed on `reason`, not on prose. */
export type ReloadBusyReason = 'session is mid-turn' | 'could not confirm the session is idle';

function busyReasonOf(error: unknown): ReloadBusyReason | null {
  const err = error as { code?: unknown; data?: { reason?: unknown } } | null;
  if (err?.code !== 'SESSION_BUSY') return null;
  const reason = err.data?.reason;
  return reason === 'session is mid-turn' ? reason : 'could not confirm the session is idle';
}

export function useSessionConfigFreshness(projectId?: string, sessionId?: string) {
  const query = useQuery({
    queryKey: sessionConfigKey(projectId, sessionId),
    queryFn: () => getProjectSessionConfigState(projectId as string, sessionId as string),
    enabled: !!projectId && !!sessionId,
    // NOT polled, on purpose. Each call drops the project's git-mirror TTL,
    // recompiles the manifest, and reaches into the sandbox — an interval would
    // make one git fetch per open session per tick, forever, to detect a thing
    // that only changes when somebody merges. Staleness is edge-triggered, so
    // this refetches on mount and on window focus, and is invalidated explicitly
    // after a reload.
    //
    // `staleTime` GATES the focus refetch, which is the whole reason it is 30s
    // and not the 5 minutes it used to be. React Query skips a focus refetch
    // while the cached value is still fresh, so with a 5-minute window the
    // ordinary flow — edit an agent file in your editor, tab back — showed
    // nothing, and a full page reload was the only thing that worked (it wipes
    // the cache rather than revalidating). 30s is long enough that alt-tabbing
    // does not turn into a git fetch per switch, short enough that coming back
    // from an edit always re-asks.
    staleTime: CONFIG_FRESHNESS_STALE_TIME_MS,
    gcTime: 10 * 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: false,
    // A session still materialising 404s. That is expected, not an error worth
    // retrying or showing.
    retry: false,
  });

  return { state: query.data, notice: sessionConfigNotice(query.data) };
}

export function useReloadSessionConfig(projectId: string, sessionId: string) {
  const queryClient = useQueryClient();
  // Held in state rather than read off `mutation.error`, because `mutate()`
  // CLEARS the previous error before it starts. Derived straight from the
  // mutation, the confirm dialog would unmount on the very click that confirms
  // it — the user would see it vanish with no indication anything was happening,
  // and its `isPending` could never be true. Cleared explicitly on dismiss and
  // on a settled attempt.
  const [busyReason, setBusyReason] = useState<ReloadBusyReason | null>(null);

  const mutation = useMutation({
    // NEVER retry. The global default retries any non-4xx once — and the API's
    // own 25s request deadline answers 503 while the reload keeps running
    // server-side, so the "failure" that triggers the retry is usually a reload
    // in progress. The retry then fires a SECOND reload, which restarts opencode
    // a second time and ends whatever turn the first restart just allowed to
    // start. A reload is cheap to repeat by hand and expensive to repeat by
    // accident.
    retry: false,
    mutationFn: (vars: { force?: boolean } = {}) =>
      // `refresh_repo` is left to the server default (true). "Reload" means
      // "catch this session up", and that includes the workspace.
      reloadProjectSessionConfig(projectId, sessionId, vars.force ? { force: true } : {}),
    onSuccess: (result: SessionReloadResult) => {
      // It landed — whatever refusal opened the dialog is answered.
      setBusyReason(null);
      queryClient.invalidateQueries({ queryKey: sessionConfigKey(projectId, sessionId) });
      if (!result.applied) {
        warningToast(reloadNotAppliedCopy(result.reason));
        return;
      }
      // Only two outcomes warrant a warning: the session's own agent files were
      // kept (so the agent still runs THEIR version), or we could not confirm.
      // The other three are successes — an earlier version keyed off a boolean
      // and warned on "already current", which is just fine. `detail` already
      // words every case.
      const needsAttention =
        result.agent_files === 'kept-yours' || result.agent_files === 'unknown';
      if (needsAttention) warningToast(result.detail);
      else successToast(result.detail || 'Config reloaded');
      // A reload RESTARTS opencode. Refreshing only the config query would
      // leave the chat bound to a runtime that just went away — so invalidate
      // exactly what a restart does.
      clearRuntimeEnsureGuard();
      queryClient.removeQueries({ queryKey: ['opencode'] });
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
      queryClient.invalidateQueries({
        queryKey: ['project', 'session-sandbox', projectId, sessionId],
      });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    // Defining `onError` here REPLACES the provider's default mutation
    // `onError`, which is what keeps a 409 from also raising a generic toast.
    onError: (error: unknown) => {
      // A busy session is not a failure — it is a question ("end the running
      // turn?"). The caller renders a confirm; toasting here would talk over it.
      const busy = busyReasonOf(error);
      if (busy) {
        setBusyReason(busy);
        return;
      }
      setBusyReason(null);
      const message = error instanceof Error ? error.message.trim() : '';
      errorToast(message || 'Reload failed. Try again in a moment.');
    },
  });

  return {
    reload: (vars: { force?: boolean } = {}) => mutation.mutate(vars),
    isPending: mutation.isPending,
    /** Set when an attempt was refused for a running turn; drives the confirm. */
    busyReason,
    clearBusy: () => setBusyReason(null),
  };
}
