/**
 * Pre-stop busy probe — the reaper's "is a process still running?" check.
 *
 * The idle heuristic (last LLM call / lastTurnAt) goes blind during long tool
 * executions, upstream retries, and subagent work: none of those leave a
 * usage_events trail while they run. That blindness is what forced the
 * autostop TTL to 120m on 2026-06-24 ("idle sandboxes were stopping too
 * quickly mid-session") — and the 2h TTL then billed every box ~2h of idle
 * tail. Instead of a huge TTL, ask the box directly before stopping it:
 * opencode's `GET /session/status` returns `{ [sessionId]: { type } }` with
 * type 'busy' | 'retry' | 'idle' for every session in the box (root and
 * subagents). Reached through the daemon's catch-all proxy, so it works on
 * every already-provisioned sandbox — no image change required.
 *
 * Fail direction: 'unknown' (unreachable box, legacy opencode without the
 * endpoint, timeout) falls through to the stop — identical to pre-probe
 * behavior. A wedged daemon must never hold compute billing open forever;
 * the probe is a veto for provably-busy boxes, not a requirement.
 */

import { resolvePreviewLink, resolveServiceKey } from '../sandbox-proxy/backend';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../shared/kortix-user-context';

export type SandboxBusyState = 'busy' | 'idle' | 'unknown';

const PROBE_TIMEOUT_MS = 3_000;
const SANDBOX_SERVICE_PORT = 8000;

/** Pure classifier for opencode's /session/status body. Exported for tests. */
export function classifySessionStatusBody(body: unknown): SandboxBusyState {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const statuses = Object.values(body as Record<string, unknown>);
  for (const s of statuses) {
    const type = (s as { type?: unknown } | null)?.type;
    if (type === 'busy' || type === 'retry') return 'busy';
  }
  return 'idle';
}

export async function probeSandboxBusy(row: {
  sandboxId: string;
  externalId: string;
}): Promise<SandboxBusyState> {
  try {
    const [link, serviceKey] = await Promise.all([
      resolvePreviewLink(row.externalId, SANDBOX_SERVICE_PORT),
      resolveServiceKey(row.sandboxId),
    ]);
    if (!serviceKey) return 'unknown';
    const headers: Record<string, string> = {
      'X-Daytona-Skip-Preview-Warning': 'true',
      'X-Daytona-Disable-CORS': 'true',
      Authorization: `Bearer ${serviceKey}`,
      [KORTIX_USER_CONTEXT_HEADER]: encodeKortixUserContext(
        {
          userId: 'system:sandbox-reaper',
          sandboxId: row.sandboxId,
          sandboxRole: 'platform_admin',
          scopes: [],
        },
        serviceKey,
      ),
    };
    if (link.token) headers['X-Daytona-Preview-Token'] = link.token;
    const res = await fetch(`${link.url}/session/status`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return 'unknown';
    return classifySessionStatusBody(await res.json());
  } catch {
    return 'unknown';
  }
}
