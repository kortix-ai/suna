/**
 * Expired-login detection (COR-144): one "Your session has ended" dialog when
 * the login is really gone, never for a transient network error, and once,
 * not once per failed request.
 *
 * Two signals start it:
 * - a 401 from the Kortix API (`configureKortix` `onError`) or the sandbox
 *   stream (`lib/session/sse-transport.ts`). A 401 alone proves nothing: the token may just
 *   be stale, or the sandbox foreign. The monitor asks Supabase to refresh the
 *   session and decides on that answer (`classifyRefreshResult`).
 * - a `SIGNED_OUT` auth event that no sign-out in the app asked for. auth-js
 *   emits it when a refresh fails for good. The refresh guard
 *   (`refresh-fetch.ts`) makes that happen only for a definitive GoTrue
 *   rejection. Every deliberate sign-out calls `disarm()` first.
 *
 * Pure except for the injected `refresh`; the Supabase wiring lives in
 * `session-expiry-monitor.ts`. `bun test` covers this file.
 */

import { create } from 'zustand';
import { DEFINITIVE_REFRESH_ERROR_CODES } from './refresh-fetch';

/** What a Supabase `refreshSession()` answer means for the login. */
export type RefreshVerdict = 'valid' | 'expired' | 'transient';

export interface RefreshResult {
  error: { name?: string; status?: number; code?: string } | null;
  hasSession: boolean;
}

/**
 * - no error and a session: the login works. No error and no session: unknown.
 * - a missing session (`AuthSessionMissingError`), or a GoTrue code that
 *   proves the refresh token or its user is gone
 *   (`DEFINITIVE_REFRESH_ERROR_CODES`, for example `refresh_token_not_found`):
 *   expired.
 * - every other error is transient and never shown: a network failure, a
 *   5xx, a 408 or 429, a 4xx with no code (a proxy or WAF answered), a
 *   discarded refresh (409), an unparsable answer.
 */
export function classifyRefreshResult(result: RefreshResult): RefreshVerdict {
  const { error } = result;
  if (!error) return result.hasSession ? 'valid' : 'transient';
  if (error.name === 'AuthSessionMissingError') return 'expired';
  return error.code && DEFINITIVE_REFRESH_ERROR_CODES.has(error.code) ? 'expired' : 'transient';
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
