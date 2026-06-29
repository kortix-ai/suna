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

export function daytonaPreviewHeaders(previewToken: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (previewToken) headers['X-Daytona-Preview-Token'] = previewToken;
  return headers;
}

/**
 * Read the daemon's `/kortix/health` once. Returns the opencode/runtime state,
 * or null when the probe itself failed (transient — the caller keeps polling).
 * Health is unauthenticated at the daemon and always answers 200, so a null
 * here means the preview link couldn't be reached, not "opencode down".
 */
async function fetchDaemonOpencodeState(
  previewUrl: string,
  previewToken: string | null,
  fetchImpl: typeof fetch,
): Promise<{ opencode: string | null; status: string | null } | null> {
  try {
    const res = await fetchImpl(`${previewUrl.replace(/\/$/, '')}/kortix/health`, {
      method: 'GET',
      headers: daytonaPreviewHeaders(previewToken),
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
  previewToken: string | null;
  budgetMs?: number;
  deps?: DaemonReadyDeps;
}): Promise<boolean> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const sleep = args.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = args.deps?.now ?? Date.now;
  const deadline = now() + (args.budgetMs ?? OPENCODE_READY_WAIT_BUDGET_MS);
  for (;;) {
    const state = await fetchDaemonOpencodeState(args.previewUrl, args.previewToken, fetchImpl);
    if (state?.opencode === 'ok') return true;
    // A repo/initial-session boot error won't clear by waiting — bail and let the
    // forward surface the real failure instead of burning the whole budget.
    if (state?.status === 'error') return false;
    if (now() >= deadline) return false;
    await sleep(OPENCODE_READY_POLL_INTERVAL_MS);
  }
}
