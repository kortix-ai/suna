'use client';

import { useTranslations } from '@/i18n/use-translations';
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
  reloadProjectSessionConfigStream,
  type SessionConfigRelease,
  type SessionConfigState,
  type SessionReloadPhase,
  type SessionReloadResult,
  sessionStartKey,
} from '@kortix/sdk';
import { clearRuntimeEnsureGuard, qk } from '@kortix/sdk/react';

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
 * Deliberately NOT a boolean and deliberately without an `ok` member: a current
 * session costs zero chrome. Still loading, an inconclusive check, nothing to
 * compare, and a box asleep all collapse to `hidden`.
 *
 * - `stale`: the session runs an older config than the one available.
 * - `fallback`: the desired config failed on the box, and an earlier config
 *   serves the session. `servingReleaseId` is null when the platform's default
 *   config serves it.
 */
export type SessionConfigNotice =
  | { kind: 'hidden' }
  | { kind: 'stale'; running: string; latest: string }
  | {
      kind: 'fallback';
      reason: string;
      source: SessionConfigRelease['source'];
      servingReleaseId: string | null;
      failedReleaseId: string | null;
    };

/** Release IDs are 64 hex characters. Twelve identify one in a header. */
const RELEASE_ID_DISPLAY_LENGTH = 12;

function shortReleaseId(id: string | null | undefined): string | null {
  return id ? id.slice(0, RELEASE_ID_DISPLAY_LENGTH) : null;
}

/**
 * Pure, so the branch order is testable without a DOM or a network.
 *
 * Order:
 * 1. `fallback` first. After a failed convergence `stale` is also true, and
 *    "update available" would offer to retry the release that just failed.
 * 2. `stale` next, as before.
 *
 * A session that edits `.kortix/opencode` in its own `/workspace` gets no
 * notice of its own: those edits reach the session only once they are pushed to
 * the base branch, and then the ordinary `stale` notice offers the reload.
 *
 * A response without `release` (an API that predates config releases) reaches
 * only the `stale` and `hidden` branches, exactly as before.
 */
export function sessionConfigNotice(state: SessionConfigState | undefined): SessionConfigNotice {
  if (!state) return { kind: 'hidden' };
  const release = state.release;
  if (release?.fallback_reason) {
    return {
      kind: 'fallback',
      reason: release.fallback_reason,
      source: release.source,
      servingReleaseId: shortReleaseId(release.running_release_id),
      failedReleaseId: shortReleaseId(release.failed_release_id),
    };
  }
  if (state.stale === true) {
    return {
      kind: 'stale',
      // A capable daemon decides `stale` by release ID, and its etags can be
      // null. An old daemon always reports both etags. The dash keeps a
      // contract change from rendering "undefined" at a user.
      running: state.running_etag ?? shortReleaseId(release?.running_release_id) ?? '—',
      latest: state.latest_etag ?? shortReleaseId(release?.desired_release_id) ?? '—',
    };
  }
  // `false` is current. `null` is inconclusive: the sandbox is sleeping, the
  // project has no compiled config, or an older runtime cannot report an etag.
  // None is an error, and none warrants persistent UI.
  return { kind: 'hidden' };
}

/**
 * The copy that says what serves the session after a fallback. The image
 * default is the platform's config, not an earlier one of this project, so it
 * is named as the platform default config (as the popover's "Now running" row
 * and the CLI name it).
 */
export function fallbackCopyKeys(source: SessionConfigRelease['source'] | undefined): {
  runs: string;
  toast: string;
} {
  if (source === 'image-default') return { runs: 'text643df05476ab', toast: 'text40652e008fc9' };
  return { runs: 'text4e62b29dd3b6', toast: 'text931cb67e2af7' };
}

/**
 * How a finished reload is announced.
 *
 * A reload that ends on a fallback kept an earlier config: that is an error,
 * never a success. `kept-yours` and `unknown` agent files are warnings, as
 * before.
 */
export function reloadResultTone(result: SessionReloadResult): 'success' | 'warning' | 'error' {
  if (result.release?.fallback_reason) return 'error';
  if (!result.applied) return 'warning';
  if (result.agent_files === 'kept-yours' || result.agent_files === 'unknown') return 'warning';
  return 'success';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<SessionReloadPhase | null>(null);
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
    mutationFn: (vars: { force?: boolean } = {}) => {
      setPhase(null);
      // A reload does BOTH halves, and the toast below names each:
      //
      //   1. the running config — the sandbox is moved onto the base branch's
      //      current release, which it serves from a read-only copy;
      //   2. the `/workspace` checkout — fast-forwarded so the files a person
      //      or an agent reads there match the config the session runs.
      //
      // (2) used to be skipped, because /workspace was the config source and a
      // pull from a UI button was a real change. It is not the config source
      // any more: the pull is `--ff-only` on the session's OWN branch and can
      // discard nothing, while a checkout left behind is exactly the confusion
      // this control exists to remove.
      return reloadProjectSessionConfigStream(
        projectId,
        sessionId,
        {
          refresh_repo: true,
          ...(vars.force ? { force: true } : {}),
        },
        (event) => {
          if (event.type === 'phase') setPhase(event.phase);
        },
      );
    },
    onSuccess: (result: SessionReloadResult) => {
      // It landed — whatever refusal opened the dialog is answered.
      setBusyReason(null);
      queryClient.invalidateQueries({ queryKey: sessionConfigKey(projectId, sessionId) });
      const tone = reloadResultTone(result);
      if (tone === 'error') {
        // The box declined the new config and kept an earlier one. The header
        // shows the same reason until the next convergence.
        errorToast(tI18nComplete.raw(fallbackCopyKeys(result.release?.source).toast), {
          description: result.release?.fallback_reason ?? undefined,
        });
      } else if (!result.applied) {
        // `detail` is the server's sentence and carries the checkout half, so
        // a half-sync is never silent behind a localized headline.
        warningToast(reloadNotAppliedCopy(result.reason), { description: result.detail });
      } else if (tone === 'warning') {
        // The session's own agent files were kept, or we could not confirm.
        // `detail` already words every case.
        warningToast(result.detail);
      } else {
        successToast(result.detail || tI18nComplete.raw('text4a920574ea10'));
      }
      if (!result.applied) return;
      // A reload RESTARTS opencode. Refreshing only the config query would
      // leave the chat bound to a runtime that just went away — so invalidate
      // exactly what a restart does.
      clearRuntimeEnsureGuard();
      queryClient.removeQueries({ queryKey: ['opencode'] });
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
      queryClient.invalidateQueries({
        queryKey: qk.project.sessionSandbox(projectId, sessionId),
      });
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
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
      errorToast(message || tI18nComplete.raw('textfe68b872c724'));
    },
    onSettled: () => setPhase(null),
  });

  return {
    reload: (vars: { force?: boolean } = {}) => mutation.mutate(vars),
    isPending: mutation.isPending,
    /** The latest server-confirmed boundary reached by the active reload. */
    phase,
    /** Set when an attempt was refused for a running turn; drives the confirm. */
    busyReason,
    clearBusy: () => setBusyReason(null),
  };
}
