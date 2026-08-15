'use client';

import { useEffect } from 'react';
import { create as createStore } from 'zustand';

import {
  ensureWarmProjectSession,
  type ProjectSession,
  type SessionConnectorBindingsInput,
} from '@kortix/sdk';

/**
 * Warm sessions — presence-driven.
 *
 * A session started from a project pays the whole sandbox boot AFTER the user
 * presses Enter. So while a logged-in user is present on a project — a project
 * route mounted AND the tab visible — keep one session already created for them.
 *
 * A warm session is NOT a species of session. It is an ORDINARY session, created
 * by the same server path the New Session button uses, that the user has not
 * typed into yet. The send path therefore does not "claim" anything: it navigates
 * to the session it already has and prompts it. No claim call, no 409
 * vocabulary, no claim PROTOCOL state — `WarmSession` caches the server row
 * itself (JAY-599/T21) purely so the taker can seed a cache with it, not as
 * negotiation state of any kind.
 *
 * CREATES at exactly three moments, no timers: on mount (or project change), on
 * regaining visibility, and to replenish after one is used. Holding an id
 * short-circuits all three, so refocusing a tab costs nothing, and a hidden tab
 * never starts billed compute.
 *
 * ABANDON, NEVER ADAPT. A warm session is born with the project's default agent
 * and sandbox. If the user picks something else before sending, the client drops
 * it and the ordinary create path runs; the abandoned box is hidden and reaped
 * like any other idle session. One wasted box, bounded — in exchange for deleting
 * every line of compatibility matching the alternative needs.
 *
 * `metadata.warm` hides the row from the `visible` session list until its first
 * prompt lands (`apps/api/src/projects/lib/session-inventory.ts`).
 *
 * COST. Gated by the `warm_sessions` project flag; the server enforces it (403
 * `feature_disabled`) and `enabled` is only the client short-circuit. The server
 * also refuses to warm into an account's LAST free concurrent-session slot, so
 * speculation can never 429 real work.
 *
 * ARCHITECTURE RULE — enforced by `warm-session-boundary.test.ts`: the browser
 * must never hand-roll speculative session creation. `ensureWarmProjectSession`
 * may be referenced from THIS FILE ONLY.
 */

/**
 * The create-time overrides a send can carry. Structurally the same object as
 * `NewProjectSessionOpts['create']`; declared here so the warm module does not
 * import from its own caller.
 */
export interface WarmSendCreateInput {
  sandbox_slug?: string;
  agent_name?: string;
  connector_bindings?: SessionConnectorBindingsInput;
  inherit_unbound?: boolean;
  require_connectors?: string[];
}

/** What was actually created, so a send can tell whether it fits. */
export interface WarmSession {
  sessionId: string;
  /** RESOLVED, as the server stored it — never the `default` sentinel. */
  agentName: string | null;
  sandboxSlug: string;
  /**
   * The full server row `ensureWarmProjectSession` returned when this session
   * was created. Carried so `takeWarmSessionEntry`'s caller (`use-new-project-
   * session.ts`) can seed the sessions-list cache with it at adoption time,
   * without a second fetch — see `warm-session-seed.ts`. Still shows
   * `metadata.warm: true` at this point; the server only drops that once
   * THIS take's own `/start` call lands (`apps/api/.../routes/r8.ts`).
   */
  session: ProjectSession;
}

/**
 * Can this warm session serve this send?
 *
 * It was created with the project's defaults and nothing else, so a send naming a
 * different agent or sandbox, or carrying per-session connector wiring, needs a
 * session that does not exist yet.
 *
 * Both sides carry RESOLVED names — the server resolves the warm session's agent
 * against the project manifest and the composer sends the name it displays — so
 * they are directly comparable. An undefined override means "the project
 * default", which is exactly what the warm session has.
 */
export function warmSessionFitsSend(
  warm: WarmSession,
  create: WarmSendCreateInput | undefined,
): boolean {
  if (!create) return true;
  if (create.connector_bindings !== undefined) return false;
  if (create.inherit_unbound !== undefined) return false;
  if (create.require_connectors !== undefined) return false;
  if (create.agent_name !== undefined && create.agent_name !== warm.agentName) return false;
  if (create.sandbox_slug !== undefined && create.sandbox_slug !== warm.sandboxSlug) return false;
  return true;
}

interface WarmSessionState {
  /** Projects whose create POST is in flight. */
  creating: Record<string, true>;
  /** The created, still-unused session per project. */
  ready: Record<string, WarmSession>;
  /**
   * Every session id THIS TAB has taken via `takeReady`. Defense in depth for
   * JAY-596 / T20: the server's own warm marker only drops on the first
   * prompt, seconds after a take, so a replenish racing that window can get
   * the just-taken session back. `excludeSessionId` (see `createWarmSession`)
   * stops a FIXED server from offering it; this set stops a server WITHOUT
   * the fix (or any other race) from ever landing it back in `ready`, no
   * matter how it got produced.
   */
  takenSessionIds: Record<string, true>;
  /** Reserve the create slot. False when one is in flight or one is ready. */
  beginCreate: (projectId: string) => boolean;
  /**
   * Release the create slot, recording the session it produced — UNLESS that
   * session id was already taken this tab, in which case it is dropped on the
   * floor. Returns whether the session was actually filed as ready, so the
   * caller (`createWarmSession`) knows whether to retry.
   */
  settleCreate: (projectId: string, session: WarmSession | null) => boolean;
  /** Read AND consume the ready session, so it is handed out once. */
  takeReady: (projectId: string) => WarmSession | null;
}

/**
 * Module state, not a ref: the project shell mounts hooks more than once and
 * React Strict Mode double-invokes effects in development. All of them must
 * share ONE in-flight create per project — same reasoning as
 * `new-session-guard.ts`.
 */
export const useWarmSessionStore = createStore<WarmSessionState>((set, get) => ({
  creating: {},
  ready: {},
  takenSessionIds: {},
  beginCreate: (projectId) => {
    const state = get();
    if (state.creating[projectId] || state.ready[projectId]) return false;
    set((current) => ({ creating: { ...current.creating, [projectId]: true } }));
    return true;
  },
  settleCreate: (projectId, session) => {
    const state = get();
    const creating = { ...state.creating };
    delete creating[projectId];
    if (!session || state.takenSessionIds[session.sessionId]) {
      set({ creating });
      return false;
    }
    set({ creating, ready: { ...state.ready, [projectId]: session } });
    return true;
  },
  takeReady: (projectId) => {
    const session = get().ready[projectId];
    if (!session) return null;
    set((state) => {
      const ready = { ...state.ready };
      delete ready[projectId];
      return {
        ready,
        takenSessionIds: { ...state.takenSessionIds, [session.sessionId]: true },
      };
    });
    return session;
  },
}));

/**
 * The one network call this module makes, injectable so its orchestration is
 * unit-tested with a plain fake instead of `mock.module('@kortix/sdk', ...)`,
 * which is process-wide in this monorepo and a hazard for sibling suites.
 */
export type WarmSessionClient = {
  create: (projectId: string, excludeSessionId?: string) => Promise<WarmSession>;
};

const defaultClient: WarmSessionClient = {
  create: async (projectId, excludeSessionId) => {
    const { session } = await ensureWarmProjectSession(
      projectId,
      excludeSessionId ? { excludeSessionId } : undefined,
    );
    return {
      sessionId: session.session_id,
      agentName: session.agent_name,
      sandboxSlug:
        typeof session.metadata?.sandbox_slug === 'string' ? session.metadata.sandbox_slug : '',
      session,
    };
  },
};

export interface CreateWarmSessionOptions {
  /** Forwarded to the client — see `ensureWarmProjectSession`'s option of the
   *  same name. Set by `takeWarmSession`'s replenish to the id it just took. */
  excludeSessionId?: string;
  /**
   * Retries left after the store rejects a produced session as already-taken
   * (see `WarmSessionState.settleCreate`). Internal — callers never set this;
   * it bounds the loop to exactly one retry per take so a server that keeps
   * echoing the excluded id cannot spin forever.
   */
  retriesLeft?: number;
}

/**
 * Create this project's warm session unless it already has one.
 *
 * Non-blocking and failure-silent by contract: nothing about the composer waits
 * on it, and a failure leaves the user on the ordinary create path with no
 * visible difference.
 *
 * If the produced session is one this tab already took (the store's
 * `settleCreate` refuses to file it), this retries EXACTLY ONCE — a server
 * without the exclusion fix, or a race, can otherwise echo the same id back
 * forever and this must not become a busy loop.
 */
export async function createWarmSession(
  projectId: string,
  client: WarmSessionClient = defaultClient,
  options: CreateWarmSessionOptions = {},
): Promise<void> {
  if (!useWarmSessionStore.getState().beginCreate(projectId)) return;
  const retriesLeft = options.retriesLeft ?? 1;
  try {
    const session = await client.create(projectId, options.excludeSessionId);
    const accepted = useWarmSessionStore.getState().settleCreate(projectId, session);
    if (!accepted && retriesLeft > 0) {
      void createWarmSession(projectId, client, {
        excludeSessionId: options.excludeSessionId,
        retriesLeft: retriesLeft - 1,
      });
    }
  } catch {
    // Invisible on purpose. A warm session is an optimization; the create path
    // is unchanged and still the authority on every gate.
    useWarmSessionStore.getState().settleCreate(projectId, null);
  }
}

export interface TakeWarmSessionOptions {
  create?: WarmSendCreateInput;
  /**
   * Create a replacement, so a second "New session" is instant too. Defaults to
   * true; still subject to the tab being visible.
   */
  replenish?: boolean;
  /**
   * The presence check for the replenish above. Injectable so tests never have
   * to install a process-wide `document` — bun runs one process for the whole
   * suite, and a fake global there breaks unrelated files that expect a real
   * DOM.
   */
  isPresent?: () => boolean;
  client?: WarmSessionClient;
}

/**
 * Take this project's warm session for a send, or null to create normally.
 *
 * Synchronous and network-free — the session already exists. Null covers both
 * "none ready" and "the one we have cannot serve this send"; either way the
 * caller falls back to the ordinary create path, which re-evaluates every gate
 * and surfaces the same outcome the user would have seen regardless.
 *
 * A warm session that does not fit is CONSUMED, not kept: the user changed their
 * mind about the agent, so it will not fit the next send either.
 */
/**
 * Take this project's warm session for a send, or null to create normally —
 * the FULL entry (id, agent, sandbox, and the server row itself), not just
 * the id. `takeWarmSession` below is the historical id-only surface every
 * existing caller and test uses; `use-new-project-session.ts` calls this one
 * so it can seed the sessions-list cache with `.session` at adoption time
 * (`warm-session-seed.ts`) — see JAY-599 / T21.
 */
export function takeWarmSessionEntry(
  projectId: string,
  options: TakeWarmSessionOptions = {},
): WarmSession | null {
  const warm = useWarmSessionStore.getState().takeReady(projectId);
  if (!warm) return null;

  // Replenish, so "New session" right after this one is instant too. Only while
  // the user is still present: a send made in a tab the user then hides must not
  // leave a fresh billed box behind. The navigation this triggers stays on a
  // project route, so tab visibility is the live signal here.
  // Fire-and-forget — the caller is mid-navigation and must not wait on it.
  //
  // excludeSessionId: warm.sessionId — see JAY-596 / T20. Without it, the
  // server's reuse lookup can find THIS session (its warm marker only drops on
  // the first prompt, seconds from now) and hand it straight back.
  if (options.replenish !== false && (options.isPresent ?? tabIsVisible)()) {
    void createWarmSession(projectId, options.client, { excludeSessionId: warm.sessionId });
  }
  return warmSessionFitsSend(warm, options.create) ? warm : null;
}

export function takeWarmSession(
  projectId: string,
  options: TakeWarmSessionOptions = {},
): string | null {
  return takeWarmSessionEntry(projectId, options)?.sessionId ?? null;
}

/** Is the user actually looking at this tab right now? */
export function tabIsVisible(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible';
}

/**
 * Keep one warm session ready while the user is present on this project.
 *
 * `enabled` carries the two reasons never to spend a box: the `warm_sessions`
 * flag is off for the project, or the account cannot run at all.
 */
export function useWarmProjectSession(projectId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!projectId || !enabled) return;

    const createIfPresent = () => {
      if (!tabIsVisible()) return;
      void createWarmSession(projectId);
    };

    createIfPresent();
    document.addEventListener('visibilitychange', createIfPresent);
    return () => document.removeEventListener('visibilitychange', createIfPresent);
  }, [projectId, enabled]);
}
