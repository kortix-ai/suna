/**
 * Pre-stop busy probe — the reaper's "is a process still running?" check.
 *
 * The idle heuristic (last LLM call / lastTurnAt) goes blind during long tool
 * executions, upstream retries, and subagent work: none of those leave a
 * usage_events trail while they run. That blindness is what forced the
 * autostop TTL to 120m on 2026-06-24 ("idle sandboxes were stopping too
 * quickly mid-session") — and the 2h TTL then billed every box ~2h of idle
 * tail. Instead of a huge TTL, ask the box directly before stopping it:
 * the Kortix daemon's health document reports whether its ACP process has an
 * in-flight JSON-RPC request. This works identically for every harness.
 *
 * Fail direction: 'unknown' (unreachable box, legacy opencode without the
 * endpoint, timeout) falls through to the stop — identical to pre-probe
 * behavior. A wedged daemon must never hold compute billing open forever;
 * the probe is a veto for provably-busy boxes, not a requirement.
 */

import { resolveSandboxIngress, resolveServiceKey } from '../sandbox-proxy/backend';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../shared/kortix-user-context';

export type SandboxBusyState = 'busy' | 'idle' | 'unknown';

const PROBE_TIMEOUT_MS = 3_000;
const SANDBOX_SERVICE_PORT = 8000;

/** Pure classifier for the harness-neutral daemon health body. */
export function classifySessionStatusBody(body: unknown): SandboxBusyState {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const busy = (body as { acp_busy?: unknown }).acp_busy;
  return typeof busy === 'boolean' ? (busy ? 'busy' : 'idle') : 'unknown';
}

export async function probeSandboxBusy(row: {
  sandboxId: string;
  externalId: string;
}): Promise<SandboxBusyState> {
  try {
    const [link, serviceKey] = await Promise.all([
      resolveSandboxIngress(row.externalId, {
        port: SANDBOX_SERVICE_PORT,
        transport: 'http',
      }),
      resolveServiceKey(row.sandboxId),
    ]);
    if (!serviceKey) return 'unknown';
    const headers: Record<string, string> = {
      ...link.headers,
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
    const res = await fetch(`${link.url}/kortix/health`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return 'unknown';
    return classifySessionStatusBody(await res.json());
  } catch {
    return 'unknown';
  }
}
