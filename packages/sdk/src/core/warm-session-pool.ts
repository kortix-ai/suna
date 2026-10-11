/**
 * The warm-session pool core — the state machine behind "keep one ready
 * session per project" (`POST /projects/:id/sessions/warm`).
 *
 * A session started from project home pays the whole sandbox boot after the
 * user presses Send. So while the user is present on a project, keep one
 * session already created for them. A send claims it with its first prompt and
 * opens a sandbox that is already up. A warm session is an ORDINARY session
 * the user has not typed into yet: the server hides it from the session list
 * (`metadata.warm`) until its first prompt lands.
 *
 * This is the machine apps/mobile's `warm-session.ts` carried as a web port
 * (Jay, 2026-09-23), moved here so every host shares one implementation. The
 * core owns the whole lifecycle — reserve, take, one-retry exclude loop,
 * prime-with-ambiguous-commit-confirm, revalidate, generation/reset/settled —
 * and stays framework-free: plain Maps and Sets, an injectable transport, an
 * injectable `fits` predicate and timer, so it unit-tests with plain fakes.
 *
 * A host adapter keeps only what is genuinely platform-specific:
 *   - the send shape and `fits` predicate (mobile: agent/model/files; web adds
 *     sandbox slug, connector bindings and provider secret pools),
 *   - the claim input's extra fields (web adds `sandbox_slug`),
 *   - presence gating and cross-tab registries around `take`/`ensure`.
 *
 * Creates happen at three moments, no timers: on entry, when the host returns
 * to the foreground, and to replace one a send used.
 *
 * ABANDON, NEVER ADAPT: a warm session is born with the project's default
 * agent and model. A send that asks for anything else consumes it and runs
 * the ordinary create; the unused box is reaped like any idle session.
 */

/** Anything a pool holds must carry the session id it is filed under. */
export interface WarmPoolSession {
  sessionId: string;
}

/**
 * The transport the pool drives — the SDK's warm-session REST surface
 * (`ensureWarmProjectSession`, `claimWarmProjectSession`, the session read).
 */
export interface WarmSessionPoolClient<Session extends WarmPoolSession, ClaimInput> {
  /** `POST /projects/:id/sessions/warm`. Resolves the held (or new) session. */
  ensure: (projectId: string, excludeSessionId?: string) => Promise<Session>;
  /** `POST /projects/:id/sessions/warm/claim`: the prompt row and the claim, one transaction. */
  claim: (projectId: string, input: ClaimInput) => Promise<unknown>;
  /** `GET /projects/:id/sessions/:sid`, errors silent. */
  read: (projectId: string, sessionId: string) => Promise<{ metadata?: unknown } | null>;
}

export interface WarmSessionPoolCoreOptions<Session extends WarmPoolSession, Send> {
  /**
   * Can this held session serve this send? The core is shape-agnostic; each
   * host decides what "fits" means for its send shape.
   */
  fits: (session: Session, send: Send) => boolean;
  /** Injectable timer for the ambiguous-commit confirmation (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface WarmSessionPoolCore<Session extends WarmPoolSession, Send, ClaimInput> {
  /** Create this project's warm session unless one is held or in flight. Never throws. */
  ensure: (projectId: string, options?: { excludeSessionId?: string }) => Promise<void>;
  /**
   * Take the held session for a send, or null for the ordinary create. Always
   * consumes what it finds. `replenish` starts a replacement that excludes the
   * taken id (its warm marker only drops on the first prompt, seconds later).
   */
  take: (projectId: string, send: Send, options: { replenish: boolean }) => Session | null;
  /** Hand a taken session its first prompt. False: refused, run the ordinary create. */
  prime: (projectId: string, session: Session, input: ClaimInput) => Promise<boolean>;
  /** Drop a held session the user opened another way. Returns its project, or null. */
  dropBySessionId: (sessionId: string) => string | null;
  /** Re-read the held row; drop it when its warm marker is gone. True when dropped. */
  revalidate: (projectId: string) => Promise<boolean>;
  held: (projectId: string) => Session | null;
  /** Sign-out: forget everything. */
  reset: () => void;
  /** Resolves when every in-flight ensure has settled (tests). */
  settled: () => Promise<void>;
}

/** Failures that say nothing about whether the server committed. */
function isAmbiguousCreateFailure(code: string | undefined): boolean {
  return code === 'TIMEOUT' || code === 'request_deadline';
}

/** The string `code` an SDK `ApiError` (or any error-like value) carries. */
function errorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isWarmRow(row: { metadata?: unknown } | null): boolean {
  const metadata = row?.metadata;
  return !!isRecord(metadata) && metadata.warm === true;
}

const COMMIT_CONFIRM_ATTEMPTS = 5;
const COMMIT_CONFIRM_DELAY_MS = 2_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask the server, up to `attempts` times, whether an ambiguous write landed.
 *
 * Polls because the commit can land AFTER the client's abort. A probe that
 * throws (a 404 before the row is visible) counts as "not yet".
 */
async function confirmCommitted(
  probe: () => Promise<boolean>,
  {
    attempts = COMMIT_CONFIRM_ATTEMPTS,
    delayMs = COMMIT_CONFIRM_DELAY_MS,
    sleep = wait,
  }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    try {
      if (await probe()) return true;
    } catch {
      // Not visible yet.
    }
  }
  return false;
}

export function createWarmSessionPool<Session extends WarmPoolSession, Send, ClaimInput>(
  client: WarmSessionPoolClient<Session, ClaimInput>,
  options: WarmSessionPoolCoreOptions<Session, Send>,
): WarmSessionPoolCore<Session, Send, ClaimInput> {
  const ready = new Map<string, Session>();
  const creating = new Set<string>();
  /** Every id this app took. A server echo of one must never be held again. */
  const taken = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  /** Bumped by `reset`, so an ensure that started before sign-out is dropped. */
  let generation = 0;

  const runEnsure = (
    projectId: string,
    excludeSessionId: string | undefined,
    retriesLeft: number,
  ): Promise<void> => {
    if (creating.has(projectId) || ready.has(projectId)) return Promise.resolve();
    creating.add(projectId);
    const startedIn = generation;
    const run = (async () => {
      let retryExclude: string | null = null;
      try {
        const session = await client.ensure(projectId, excludeSessionId);
        if (startedIn !== generation) return;
        if (taken.has(session.sessionId)) retryExclude = session.sessionId;
        else ready.set(projectId, session);
      } catch {
        // Invisible on purpose: the ordinary create is unchanged and still the
        // authority on every gate (billing, connectors).
      } finally {
        if (startedIn === generation) creating.delete(projectId);
      }
      // One retry, excluding the echoed id, so a server that keeps offering a
      // taken session cannot become a loop.
      if (retryExclude && retriesLeft > 0) {
        await runEnsure(projectId, retryExclude, retriesLeft - 1);
      }
    })();
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
    return run;
  };

  return {
    ensure: (projectId, opts) => runEnsure(projectId, opts?.excludeSessionId, 1),

    take: (projectId, send, { replenish }) => {
      const warm = ready.get(projectId);
      if (!warm) return null;
      ready.delete(projectId);
      taken.add(warm.sessionId);
      if (replenish) void runEnsure(projectId, warm.sessionId, 1);
      return options.fits(warm, send) ? warm : null;
    },

    prime: async (projectId, warm, input) => {
      try {
        await client.claim(projectId, input);
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
