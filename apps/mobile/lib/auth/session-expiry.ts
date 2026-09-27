/**
 * Expired-login detection (COR-144): one "Your session has ended" dialog when
 * the login is really gone, never for a transient network error, and once,
 * not once per failed request.
 *
 * Two signals start it:
 * - a 401 from the Kortix API (`configureKortix` `onError`) or the sandbox
 *   stream (`event-stream.ts`). A 401 alone proves nothing: the token may just
 *   be stale, or the sandbox foreign. The monitor asks Supabase to refresh the
 *   session and decides on that answer (`classifyRefreshResult`).
 * - a `SIGNED_OUT` auth event that no sign-out in the app asked for. auth-js
 *   emits it when a refresh fails for good (revoked or expired refresh token).
 *   Every deliberate sign-out calls `disarm()` first.
 *
 * Pure except for the injected `refresh`; the Supabase wiring lives in
 * `session-expiry-monitor.ts`. `bun test` covers this file.
 */

import { create } from 'zustand';

/** What a Supabase `refreshSession()` answer means for the login. */
export type RefreshVerdict = 'valid' | 'expired' | 'transient';

export interface RefreshResult {
  error: { name?: string; status?: number } | null;
  hasSession: boolean;
}

/**
 * - no error and a session: the login works.
 * - a network failure (`AuthRetryableFetchError`, no status, 5xx), a timeout
 *   (408), or a rate limit (429): unknown, so transient. Never shown.
 * - a missing session (`AuthSessionMissingError`), or any other 4xx (auth-js
 *   answers 400 `refresh_token_not_found` / `session_not_found` for a dead
 *   refresh token): expired.
 */
export function classifyRefreshResult(result: RefreshResult): RefreshVerdict {
  const { error } = result;
  if (!error) return result.hasSession ? 'valid' : 'transient';
  if (error.name === 'AuthRetryableFetchError') return 'transient';
  if (error.name === 'AuthSessionMissingError') return 'expired';
  const status = error.status;
  if (typeof status !== 'number' || status === 0 || status >= 500) return 'transient';
  if (status === 408 || status === 429) return 'transient';
  if (status >= 400) return 'expired';
  return 'transient';
}

/**
 * After a check that found the login valid (or could not tell), further 401s
 * inside this window are ignored. A 401 loop (a foreign sandbox answering
 * 401 to every reconnect) then costs one refresh per window, not one per
 * request.
 */
export const EXPIRY_CHECK_COOLDOWN_MS = 30_000;

export type SessionExpiryPhase =
  /** Nobody is signed in, or a sign-out the app asked for is running. */
  | 'signed-out'
  /** Signed in; a 401 or an unrequested `SIGNED_OUT` is checked. */
  | 'armed'
  /** A refresh is in flight after a 401. */
  | 'checking'
  /** The login ended; the dialog shows until the user signs in again. */
  | 'expired';

export interface SessionExpiryMonitorDeps {
  refresh: () => Promise<RefreshResult>;
  onChange: (phase: SessionExpiryPhase) => void;
  now?: () => number;
}

export interface SessionExpiryMonitor {
  phase: () => SessionExpiryPhase;
  /** A user is signed in. Clears a previous expiry. */
  arm: () => void;
  /** A deliberate sign-out starts: the `SIGNED_OUT` it causes is expected. */
  disarm: () => void;
  /** A request answered 401. Resolves with the verdict, or `null` when skipped. */
  reportUnauthorized: () => Promise<RefreshVerdict | null>;
  /** auth-js emitted `SIGNED_OUT`. */
  signedOut: () => void;
}

export function createSessionExpiryMonitor(deps: SessionExpiryMonitorDeps): SessionExpiryMonitor {
  const now = deps.now ?? Date.now;
  let phase: SessionExpiryPhase = 'signed-out';
  let quietUntil = 0;
  // Bumped by arm/disarm, so a check that started before them cannot write.
  let generation = 0;

  const setPhase = (next: SessionExpiryPhase) => {
    if (next === phase) return;
    phase = next;
    deps.onChange(next);
  };

  return {
    phase: () => phase,
    arm: () => {
      generation++;
      quietUntil = 0;
      setPhase('armed');
    },
    disarm: () => {
      generation++;
      setPhase('signed-out');
    },
    reportUnauthorized: async () => {
      if (phase !== 'armed' || now() < quietUntil) return null;
      const started = ++generation;
      setPhase('checking');
      let verdict: RefreshVerdict;
      try {
        verdict = classifyRefreshResult(await deps.refresh());
      } catch {
        verdict = 'transient';
      }
      // arm, disarm and signedOut bump the generation: their phase wins.
      if (started !== generation) return verdict;
      if (verdict === 'expired') {
        setPhase('expired');
      } else {
        quietUntil = now() + EXPIRY_CHECK_COOLDOWN_MS;
        setPhase('armed');
      }
      return verdict;
    },
    signedOut: () => {
      if (phase !== 'armed' && phase !== 'checking') return;
      generation++;
      setPhase('expired');
    },
  };
}

/** The phase the dialog renders from. Written only by the monitor's `onChange`. */
export const useSessionExpiryStore = create<{ phase: SessionExpiryPhase }>(() => ({
  phase: 'signed-out',
}));
