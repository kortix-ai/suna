// Daemon-readiness polling, factored out of sandbox-env-sync so it can be unit
// tested without pulling in db/config. No heavy imports here on purpose.

// When a prompt's env sync changes model-affecting env, the daemon RESTARTS
// opencode and returns 200 the instant the new process is spawned — while it
// reports `opencode: 'starting'`, not yet able to serve `/session/.../prompt`.
// If we forwarded the prompt right then, the daemon's own proxy 503s
// "opencode not ready" and the preview proxy bounces that straight to the
// client (no retry) — so the FIRST prompt of every new session was silently
// dropped and the user had to resend. Block the sync until opencode is serving
// again, bounded well under the 50s proxy budget, so the forward always lands
// on a ready runtime. A genuinely cold boot that misses the budget just falls
// back to today's behaviour (forward → 503 → client retry), never worse.
const OPENCODE_READY_WAIT_BUDGET_MS = 18_000;
const OPENCODE_READY_POLL_INTERVAL_MS = 300;
const HEALTH_FETCH_TIMEOUT_MS = 2_000;

export interface DaemonReadyDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Is there an opencode restart in flight worth blocking the prompt on?
 *
 * The readiness wait below exists for exactly ONE situation: a model-affecting
 * env change made the daemon restart opencode, and forwarding the prompt into
 * that restart window 503s "opencode not ready" and silently drops it. The
 * daemon restarts opencode iff `refreshModels && (projectEnvChanged ||
 * opencodeEnvChanged)` — see the `/kortix/env` handler in
 * apps/kortix-sandbox-agent-server/src/routes/env.ts. So that predicate is what
 * decides whether anything is starting up; the reported STATE alone is not.
 *
 * This used to be `opencodeState !== 'ok'`, which was wrong in the one case
 * that matters most for latency: a managed-ACP session never runs the opencode
 * HTTP server at all, so the daemon reports `'down'` forever. Every ACP prompt
 * therefore burned the full 18s budget polling for a process nobody was
 * starting — 20-24s of dead time on every turn, ~70% of the user-visible
 * per-turn latency, with the LLM call itself only ~5s of it.
 *
 * `'down'` still counts as "wait" when a restart DID happen: `stop()` sets the
 * state to `'down'` and `start()` only moves it to `'starting'` once the
 * readiness probe runs, so the daemon can legitimately answer `'down'` in the
 * moment right after `restart()` (opencode.ts's supervisor). Gating on the
 * restart predicate rather than the state keeps that case covered.
 */
export function shouldWaitForOpencodeReady(args: {
  refreshModels: boolean;
  projectEnvChanged: boolean;
  opencodeEnvChanged: boolean;
  opencodeState: string | null;
}): boolean {
  // Already serving: nothing to wait for, whatever else happened.
  if (args.opencodeState === 'ok') return false;
  // Opencode is mid-boot for ANY reason — a restart we caused, or a genuinely
  // cold first prompt on a fresh sandbox. Forwarding into that window is the
  // 503 "opencode not ready" this wait exists to prevent, so wait regardless of
  // the change flags. This is the case `opencodeState !== 'ok'` was really
  // reaching for; `'down'` is what it over-matched.
  if (args.opencodeState === 'starting') return true;
  // `'down'` is worth waiting on ONLY when the daemon actually restarted
  // opencode: `stop()` sets `'down'` and `start()` only advances it once the
  // readiness probe runs, so the daemon can legitimately answer `'down'` in the
  // moment right after `restart()`. Without a restart, `'down'` is the
  // permanent steady state of a managed-ACP session and there is nothing coming.
  if (args.opencodeState === 'down') {
    return args.refreshModels && (args.projectEnvChanged || args.opencodeEnvChanged);
  }
  // No state reported at all (older daemon build, or a parse failure): never
  // wait. This keeps the predicate a STRICT SUBSET of the condition it replaced
  // (`opencodeState && opencodeState !== 'ok'`, which also skipped a null
  // state), so this change can only ever remove a wait, never add one.
  return false;
}

/**
 * Read the daemon's `/kortix/health` once. Returns the opencode/runtime state,
 * or null when the probe itself failed (transient — the caller keeps polling).
 * Health is unauthenticated at the daemon and always answers 200, so a null
 * here means the preview link couldn't be reached, not "opencode down".
 */
async function fetchDaemonOpencodeState(
  previewUrl: string,
  providerHeaders: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ opencode: string | null; status: string | null } | null> {
  try {
    const res = await fetchImpl(`${previewUrl.replace(/\/$/, '')}/kortix/health`, {
      method: 'GET',
      headers: providerHeaders,
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { opencode?: unknown; status?: unknown }
      | null;
    if (!body) return null;
    return {
      opencode: typeof body.opencode === 'string' ? body.opencode : null,
      status: typeof body.status === 'string' ? body.status : null,
    };
  } catch {
    return null;
  }
}

/**
 * Poll `/kortix/health` until opencode is serving again after a restart.
 * Returns true once `opencode === 'ok'`, false if a boot error is reported
 * (waiting can't fix it) or the budget is exhausted.
 */
export async function waitForDaemonOpencodeReady(args: {
  previewUrl: string;
  providerHeaders?: Record<string, string>;
  budgetMs?: number;
  deps?: DaemonReadyDeps;
}): Promise<boolean> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const sleep = args.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = args.deps?.now ?? Date.now;
  const deadline = now() + (args.budgetMs ?? OPENCODE_READY_WAIT_BUDGET_MS);
  for (;;) {
    const state = await fetchDaemonOpencodeState(args.previewUrl, args.providerHeaders ?? {}, fetchImpl);
    if (state?.opencode === 'ok') return true;
    // A repo/initial-session boot error won't clear by waiting — bail and let the
    // forward surface the real failure instead of burning the whole budget.
    if (state?.status === 'error') return false;
    if (now() >= deadline) return false;
    await sleep(OPENCODE_READY_POLL_INTERVAL_MS);
  }
}
