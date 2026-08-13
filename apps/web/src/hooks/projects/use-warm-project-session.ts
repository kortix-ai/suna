'use client';

import { useEffect } from 'react';
import { create as createStore } from 'zustand';

import {
  claimWarmProjectSession,
  ensureWarmProjectSession,
  type ClaimWarmProjectSessionInput,
  type PendingSessionPrompt,
  type SessionConnectorBindingsInput,
} from '@kortix/sdk';

/**
 * Warm sessions — presence-driven.
 *
 * The problem: a session started from a project pays the whole sandbox boot
 * AFTER the user presses Enter. The prompt sits there while a cold box comes
 * up.
 *
 * The rule: **while a logged-in user is actively present on a project, keep
 * exactly one warm session ready for them.** Present means a project route is
 * mounted AND the tab is visible. The send path then CLAIMS that session
 * instead of creating a cold one.
 *
 * `POST /projects/:id/sessions/warm` is idempotent per (project, creator): it
 * is serialized by a pg advisory transaction lock and backed by the partial
 * unique index at `packages/db/src/schema/kortix.ts:791`, which permits at most
 * one `available` row. So repeated ensures are naturally cheap — the second one
 * reuses. That index is the bookkeeping; this module deliberately keeps almost
 * none of its own. Reuse also refreshes the warm workspace to the latest base
 * ref and pushes the latest compiled agent config, so a warm session cannot go
 * stale.
 *
 * WHEN IT ENSURES — exactly three moments, no timers:
 *   1. a project route mounts (or the project changes),
 *   2. the tab becomes visible again (Page Visibility API),
 *   3. after a claim, to replenish — but only while still present.
 * Never on an interval, never on in-project navigation, never for a hidden
 * tab. A background tab must not hold billed compute.
 *
 * The warm row carries `metadata.warm_session.state = 'available'` until it is
 * claimed. The API hides unclaimed rows from the `visible` session list
 * (`apps/api/src/projects/lib/session-inventory.ts`), so a warm session the
 * user never used never shows up in the sidebar.
 *
 * COST. A warm sandbox is billed compute even when idle, so this is gated by
 * the `warm_sessions` project feature flag (default ON, enforcement `routes`).
 * The server is the guarantee — the endpoints 403 `feature_disabled` when it is
 * off. `enabled` below is the client-side short-circuit that avoids a pointless
 * 403 on every visit.
 *
 * ARCHITECTURE RULE — enforced by `warm-session-boundary.test.ts`:
 * the browser must never hand-roll speculative session creation. The SDK's
 * `ensureWarmProjectSession` / `claimWarmProjectSession` may be referenced from
 * THIS FILE ONLY. Every other module in `apps/web/src` goes through
 * `useWarmProjectSession` and `claimWarmSession`.
 */

/**
 * The create-time overrides a send can carry. Structurally the same object as
 * `NewProjectSessionOpts['create']`; declared here so the warm module does not
 * import from its own caller.
 */
export interface WarmClaimCreateInput {
  sandbox_slug?: string;
  agent_name?: string;
  pending_prompt?: PendingSessionPrompt;
  connector_bindings?: SessionConnectorBindingsInput;
  inherit_unbound?: boolean;
  require_connectors?: string[];
}

/**
 * Can a warm session serve this send at all?
 *
 * A warm row is born with the project's DEFAULT base ref, agent and sandbox
 * slug, and `POST /sessions/warm/claim` accepts only `agent_name`,
 * `sandbox_slug` and `pending_prompt`. Per-session connector wiring
 * (`connector_bindings`, `inherit_unbound`, `require_connectors`) is a
 * CREATE-time argument with no claim-time equivalent, so a send carrying any of
 * it must take the normal create path rather than silently drop the wiring.
 *
 * `agent_name` / `sandbox_slug` ARE forwarded, and the server rejects a
 * mismatch with 409 `WARM_SESSION_CONFIGURATION_MISMATCH` — the caller falls
 * back to create on that, so this predicate stays cheap and does not need to
 * know the project's defaults.
 */
export function warmClaimIsPossible(create: WarmClaimCreateInput | undefined): boolean {
  if (!create) return true;
  if (create.connector_bindings !== undefined) return false;
  if (create.inherit_unbound !== undefined) return false;
  if (create.require_connectors !== undefined) return false;
  return true;
}

/** The claim payload for a send — only the fields the claim route accepts. */
export function warmClaimInput(
  sessionId: string,
  create: WarmClaimCreateInput | undefined,
): ClaimWarmProjectSessionInput {
  const input: ClaimWarmProjectSessionInput = { session_id: sessionId };
  if (create?.agent_name) input.agent_name = create.agent_name;
  if (create?.sandbox_slug) input.sandbox_slug = create.sandbox_slug;
  if (create?.pending_prompt) input.pending_prompt = create.pending_prompt;
  return input;
}

/** Repeat mounts of the same project share ONE ensure. */
export function canBeginWarmEnsure(
  ensuring: Record<string, true>,
  projectId: string,
): boolean {
  return !ensuring[projectId];
}

interface WarmIndexSessionState {
  /** Projects whose ensure POST is in flight. */
  ensuring: Record<string, true>;
  /** The ready, still-unclaimed warm session id per project. */
  ready: Record<string, string>;
  /** Claim the ensure slot. Returns false when one is already in flight. */
  beginEnsure: (projectId: string) => boolean;
  /** Release the ensure slot, recording the warm session id it produced. */
  settleEnsure: (projectId: string, sessionId: string | null) => void;
  /** Read AND consume the ready warm session id, so it is claimed once. */
  takeReady: (projectId: string) => string | null;
}

/**
 * Module state, not a ref: the project shell mounts hooks more than once and
 * React Strict Mode double-invokes effects in development. All of them must
 * share ONE in-flight ensure per project — same reasoning as
 * `new-session-guard.ts`.
 */
export const useWarmIndexSessionStore = createStore<WarmIndexSessionState>((set, get) => ({
  ensuring: {},
  ready: {},
  beginEnsure: (projectId) => {
    if (!canBeginWarmEnsure(get().ensuring, projectId)) return false;
    set((state) => ({ ensuring: { ...state.ensuring, [projectId]: true } }));
    return true;
  },
  settleEnsure: (projectId, sessionId) =>
    set((state) => {
      const ensuring = { ...state.ensuring };
      delete ensuring[projectId];
      if (!sessionId) return { ensuring };
      return { ensuring, ready: { ...state.ready, [projectId]: sessionId } };
    }),
  takeReady: (projectId) => {
    const sessionId = get().ready[projectId];
    if (!sessionId) return null;
    set((state) => {
      const ready = { ...state.ready };
      delete ready[projectId];
      return { ready };
    });
    return sessionId;
  },
}));

/**
 * The two network calls this module makes, injectable so its orchestration is
 * unit-tested with a plain fake instead of `mock.module('@kortix/sdk', ...)`,
 * which is process-wide in this monorepo and a hazard for sibling suites.
 */
export type WarmIndexSessionClient = {
  ensure: (projectId: string) => Promise<string>;
  claim: (projectId: string, input: ClaimWarmProjectSessionInput) => Promise<string>;
};

const defaultClient: WarmIndexSessionClient = {
  ensure: async (projectId) => (await ensureWarmProjectSession(projectId)).session.session_id,
  claim: async (projectId, input) => (await claimWarmProjectSession(projectId, input)).session_id,
};

/**
 * Ensure this project has a warm session. Non-blocking and failure-silent by
 * contract: nothing about the composer waits on it, and a failure leaves the
 * user on the ordinary create path with no visible difference.
 */
export async function ensureWarmSession(
  projectId: string,
  client: WarmIndexSessionClient = defaultClient,
): Promise<void> {
  if (!useWarmIndexSessionStore.getState().beginEnsure(projectId)) return;
  try {
    const sessionId = await client.ensure(projectId);
    useWarmIndexSessionStore.getState().settleEnsure(projectId, sessionId);
  } catch {
    // Invisible on purpose. A warm session is an optimization; the create path
    // is unchanged and still the authority on every gate.
    useWarmIndexSessionStore.getState().settleEnsure(projectId, null);
  }
}

export interface ClaimWarmSessionOptions {
  create?: WarmClaimCreateInput;
  /**
   * Runs with the warm session id the moment the claim POST goes out. The
   * caller prefetches the route bundle here so it overlaps the claim, exactly
   * as the create path prefetches before its own POST.
   */
  onClaiming?: (sessionId: string) => void;
  /**
   * Warm a replacement after a successful claim, so a second "New session" is
   * instant too. Defaults to true; still subject to the tab being visible.
   */
  replenish?: boolean;
  /**
   * The presence check for the replenish above. Injectable so tests never have
   * to install a process-wide `document` — bun runs one process for the whole
   * suite, and a fake global there breaks unrelated files that expect a real
   * DOM.
   */
  isPresent?: () => boolean;
  client?: WarmIndexSessionClient;
}

/**
 * Claim this project's warm session for a send.
 *
 * Returns the claimed session id, or `null` when there is nothing to claim and
 * the caller must create a session normally. `null` covers every failure —
 * no warm session ready yet, a 409 because another tab won the race or the
 * agent/sandbox no longer matches, and any transport error. Falling back is
 * always safe because the create path re-evaluates every gate (billing,
 * session cap, connector requirements) and surfaces the same outcome the user
 * would have seen without a warm session.
 */
export async function claimWarmSession(
  projectId: string,
  options: ClaimWarmSessionOptions = {},
): Promise<string | null> {
  if (!warmClaimIsPossible(options.create)) return null;
  const sessionId = useWarmIndexSessionStore.getState().takeReady(projectId);
  if (!sessionId) return null;

  options.onClaiming?.(sessionId);
  const client = options.client ?? defaultClient;
  let claimed: string;
  try {
    claimed = await client.claim(projectId, warmClaimInput(sessionId, options.create));
  } catch {
    return null;
  }

  // Replenish, so "New session" right after this one is instant too. Only while
  // the user is still present: a claim made in a tab the user then hides must
  // not leave a fresh billed box behind. The navigation this claim triggers
  // stays on a project route, so tab visibility is the live signal here.
  // Fire-and-forget — the caller is mid-navigation and must not wait on it.
  if (options.replenish !== false && (options.isPresent ?? tabIsVisible)()) {
    void ensureWarmSession(projectId, client);
  }
  return claimed;
}

/** Is the user actually looking at this tab right now? */
export function tabIsVisible(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible';
}

/**
 * Keep one warm session ready while the user is present on this project.
 *
 * Presence = this hook is mounted (a project route is on screen) AND the tab is
 * visible AND `enabled`. `enabled` carries the two reasons never to spend a box:
 * the `warm_sessions` feature flag is off for the project, or the account
 * cannot run at all.
 *
 * Mount and visibility-regain both ensure. Nothing else does — no interval, no
 * per-navigation refire. A hidden tab holds no warm box beyond the sandbox
 * deadline already ticking on it.
 */
export function useWarmProjectSession(projectId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!projectId || !enabled) return;

    const ensureIfPresent = () => {
      if (!tabIsVisible()) return;
      void ensureWarmSession(projectId);
    };

    ensureIfPresent();
    document.addEventListener('visibilitychange', ensureIfPresent);
    return () => document.removeEventListener('visibilitychange', ensureIfPresent);
  }, [projectId, enabled]);
}
