/**
 * Warm sessions on mobile — the port of apps/web
 * `hooks/projects/use-warm-project-session.ts` (Jay, 2026-09-23).
 *
 * A session started from project home pays the whole sandbox boot after the
 * user presses Send. So while the user is present on a project (the project
 * screen is mounted AND the app is in the foreground), keep one session already
 * created for them. A send claims it with its first prompt and opens a sandbox
 * that is already up.
 *
 * A warm session is an ORDINARY session the user has not typed into yet. The
 * server hides it from the session list (`metadata.warm`) until its first
 * prompt lands, gates it by the `warm_sessions` project flag (on by default),
 * and never warms into an account's last free concurrent-session slot.
 *
 * Creates happen at three moments, no timers: on mount, when the app comes
 * back to the foreground, and to replace one a send used.
 *
 * ABANDON, NEVER ADAPT: a warm session is born with the project's default
 * agent and model. A send that asks for anything else (another agent, a picked
 * model, attached files) consumes it and runs the ordinary create; the unused
 * box is reaped like any idle session.
 *
 * Mobile has one app instance, so web's cross-tab registry is not ported. The
 * other-device case is covered the same way web covers other browsers:
 * `revalidate` re-reads the held row when the app returns to the foreground.
 *
 * Framework-free and injectable (`WarmSessionClient`), so it is unit-tested
 * with plain fakes. The SDK-backed pool is `warm-session-pool.ts`.
 */
import { confirmCommitted, errorCode, isAmbiguousCreateFailure } from '@kortix/shared';

export interface WarmSession {
  sessionId: string;
  /** The agent the server resolved for this session, never a sentinel. */
  agentName: string | null;
}

/** The first prompt, in the SDK's `PendingSessionPrompt` shape. */
export interface WarmPendingPrompt {
  text: string;
  agent: string | null;
  model: { providerID: string; modelID: string } | null;
  variant: string | null;
}

export interface WarmSessionClient {
  /** `POST /projects/:id/sessions/warm`. Resolves the held (or new) session. */
  ensure: (projectId: string, excludeSessionId?: string) => Promise<WarmSession>;
  /** `POST /projects/:id/sessions/warm/claim`: the prompt row and the claim, one transaction. */
  claim: (
    projectId: string,
    input: { session_id: string; agent_name?: string; pending_prompt: WarmPendingPrompt },
  ) => Promise<unknown>;
  /** `GET /projects/:id/sessions/:sid`, errors silent. */
  read: (projectId: string, sessionId: string) => Promise<{ metadata?: unknown } | null>;
}

/** What a project-home send asks for. */
export interface WarmSend {
  /** The agent the send names, or null for the project default. */
  agentName: string | null;
  /** A picked model (gateway id), or null for the project default. */
  model: string | null;
  hasFiles: boolean;
}

/**
 * Can this warm session serve this send? It was created with the project's
 * defaults and nothing else. Files ride the ordinary path, which delivers them
 * once the sandbox is reachable.
 */
export function warmFitsSend(warm: WarmSession, send: WarmSend): boolean {
  if (send.hasFiles) return false;
  if (send.model !== null) return false;
  if (send.agentName !== null && send.agentName !== warm.agentName) return false;
  return true;
}

function isWarmRow(row: { metadata?: unknown } | null): boolean {
  const metadata = row?.metadata;
  return !!metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).warm === true;
}

export interface WarmSessionPool {
  /** Create this project's warm session unless one is held or in flight. Never throws. */
  ensure: (projectId: string, options?: { excludeSessionId?: string }) => Promise<void>;
  /**
   * Take the held session for a send, or null for the ordinary create. Always
   * consumes what it finds. `replenish` starts a replacement that excludes the
   * taken id (its warm marker only drops on the first prompt, seconds later).
   */
  take: (projectId: string, send: WarmSend, options: { replenish: boolean }) => WarmSession | null;
  /** Hand a taken session its first prompt. False: refused, run the ordinary create. */
  prime: (
    projectId: string,
    warm: WarmSession,
    prompt: WarmPendingPrompt,
    agentName: string | null,
  ) => Promise<boolean>;
  /** Drop a held session the user opened another way. Returns its project, or null. */
  dropBySessionId: (sessionId: string) => string | null;
  /** Re-read the held row; drop it when its warm marker is gone. True when dropped. */
  revalidate: (projectId: string) => Promise<boolean>;
  held: (projectId: string) => WarmSession | null;
  /** Sign-out: forget everything. */
  reset: () => void;
  /** Resolves when every in-flight ensure has settled (tests). */
  settled: () => Promise<void>;
}

export function createWarmSessionPool(
  client: WarmSessionClient,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): WarmSessionPool {
  const ready = new Map<string, WarmSession>();
  const creating = new Set<string>();
  /** Every id this app took. A server echo of one must never be held again. */
  const taken = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  /** Bumped by `reset`, so an ensure that started before sign-out is dropped. */
  let generation = 0;

  const ensure = (projectId: string, opts: { excludeSessionId?: string; retriesLeft?: number } = {}) => {
    if (creating.has(projectId) || ready.has(projectId)) return Promise.resolve();
    creating.add(projectId);
    const startedIn = generation;
    const retriesLeft = opts.retriesLeft ?? 1;
    const run = (async () => {
      let retryExclude: string | null = null;
      try {
        const session = await client.ensure(projectId, opts.excludeSessionId);
        if (startedIn !== generation) return;
        if (taken.has(session.sessionId)) retryExclude = session.sessionId;
        else ready.set(projectId, session);
      } catch {
        // Invisible on purpose: the ordinary create is unchanged and still the
        // authority on every gate (billing, session cap, connectors).
      } finally {
        if (startedIn === generation) creating.delete(projectId);
      }
      // One retry, excluding the echoed id, so a server that keeps offering a
      // taken session cannot become a loop.
      if (retryExclude && retriesLeft > 0) {
        await ensure(projectId, { excludeSessionId: retryExclude, retriesLeft: retriesLeft - 1 });
      }
    })();
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
    return run;
  };

  return {
    ensure: (projectId, opts) => ensure(projectId, opts),

    take: (projectId, send, { replenish }) => {
      const warm = ready.get(projectId);
      if (!warm) return null;
      ready.delete(projectId);
      taken.add(warm.sessionId);
      if (replenish) void ensure(projectId, { excludeSessionId: warm.sessionId });
      return warmFitsSend(warm, send) ? warm : null;
    },

    prime: async (projectId, warm, prompt, agentName) => {
      try {
        await client.claim(projectId, {
          session_id: warm.sessionId,
          ...(agentName ? { agent_name: agentName } : {}),
          pending_prompt: prompt,
        });
        return true;
      } catch (error) {
        if (!isAmbiguousCreateFailure(errorCode(error))) return false;
        // A timed-out claim can still commit. The claim drops the warm marker
        // in the same transaction that stores the prompt, so a row without the
        // marker already holds this prompt: answering false would send it
        // through a second create — two sessions, two answers.
        return confirmCommitted(
          async () => !isWarmRow(await client.read(projectId, warm.sessionId)),
          options.sleep ? { sleep: options.sleep } : {},
        );
      }
    },

    dropBySessionId: (sessionId) => {
      for (const [projectId, warm] of ready) {
        if (warm.sessionId !== sessionId) continue;
        ready.delete(projectId);
        taken.add(sessionId);
        return projectId;
      }
      return null;
    },

    revalidate: async (projectId) => {
      const held = ready.get(projectId);
      if (!held) return false;
      try {
        if (isWarmRow(await client.read(projectId, held.sessionId))) return false;
      } catch {
        // Fail open: a network blip must not discard a good warm session.
        return false;
      }
      // Drop only if a send did not take it while the read was in flight.
      if (ready.get(projectId)?.sessionId !== held.sessionId) return false;
      ready.delete(projectId);
      taken.add(held.sessionId);
      return true;
    },

    held: (projectId) => ready.get(projectId) ?? null,

    reset: () => {
      generation += 1;
      ready.clear();
      creating.clear();
      taken.clear();
    },

    settled: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
