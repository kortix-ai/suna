'use client';

import { useEffect } from 'react';
import { create as createStore } from 'zustand';

import {
  ensureWarmProjectSession,
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
 * to the session it already has and prompts it. No claim call, no 409 vocabulary,
 * no client state beyond the id.
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
  /** Reserve the create slot. False when one is in flight or one is ready. */
  beginCreate: (projectId: string) => boolean;
  /** Release the create slot, recording the session it produced. */
  settleCreate: (projectId: string, session: WarmSession | null) => void;
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
  beginCreate: (projectId) => {
    const state = get();
    if (state.creating[projectId] || state.ready[projectId]) return false;
    set((current) => ({ creating: { ...current.creating, [projectId]: true } }));
    return true;
  },
  settleCreate: (projectId, session) =>
    set((state) => {
      const creating = { ...state.creating };
      delete creating[projectId];
      if (!session) return { creating };
      return { creating, ready: { ...state.ready, [projectId]: session } };
    }),
  takeReady: (projectId) => {
    const session = get().ready[projectId];
    if (!session) return null;
    set((state) => {
      const ready = { ...state.ready };
      delete ready[projectId];
      return { ready };
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
  create: (projectId: string) => Promise<WarmSession>;
};

const defaultClient: WarmSessionClient = {
  create: async (projectId) => {
    const { session } = await ensureWarmProjectSession(projectId);
    return {
      sessionId: session.session_id,
      agentName: session.agent_name,
      sandboxSlug:
        typeof session.metadata?.sandbox_slug === 'string' ? session.metadata.sandbox_slug : '',
    };
  },
};

/**
 * Create this project's warm session unless it already has one.
 *
 * Non-blocking and failure-silent by contract: nothing about the composer waits
 * on it, and a failure leaves the user on the ordinary create path with no
 * visible difference.
 */
export async function createWarmSession(
  projectId: string,
  client: WarmSessionClient = defaultClient,
): Promise<void> {
  if (!useWarmSessionStore.getState().beginCreate(projectId)) return;
  try {
    useWarmSessionStore.getState().settleCreate(projectId, await client.create(projectId));
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
export function takeWarmSession(
  projectId: string,
  options: TakeWarmSessionOptions = {},
): string | null {
  const warm = useWarmSessionStore.getState().takeReady(projectId);
  if (!warm) return null;

  // Replenish, so "New session" right after this one is instant too. Only while
  // the user is still present: a send made in a tab the user then hides must not
  // leave a fresh billed box behind. The navigation this triggers stays on a
  // project route, so tab visibility is the live signal here.
  // Fire-and-forget — the caller is mid-navigation and must not wait on it.
  if (options.replenish !== false && (options.isPresent ?? tabIsVisible)()) {
    void createWarmSession(projectId, options.client);
  }
  return warmSessionFitsSend(warm, options.create) ? warm.sessionId : null;
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
