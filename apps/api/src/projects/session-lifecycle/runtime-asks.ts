import { resolveSessionRuntimeEndpoint } from './runtime-client';
import { runtimeVerbPaths, sessionRuntimeFetch } from './runtime-fetch';

export type RuntimeAskOutcome = 'released' | 'not_waiting' | 'unreachable';

/**
 * Decide a permission request the runtime still holds live (the call runs, or
 * is refused, in the same turn). `not_waiting`: the runtime answered 404, so
 * the call parked (or the box restarted) and the decision reaches the agent as
 * a message instead (lib/pending-permissions.ts).
 */
export async function replyRuntimePermission(
  sessionId: string,
  requestId: string,
  reply: 'once' | 'always' | 'reject',
): Promise<RuntimeAskOutcome> {
  try {
    const resolved = await resolveSessionRuntimeEndpoint(sessionId);
    if (!resolved) return 'unreachable';
    const res = await sessionRuntimeFetch(resolved.endpoint, 'POST', runtimeVerbPaths.permissionReply(requestId), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
    });
    if (res.ok) return 'released';
    return res.status === 404 ? 'not_waiting' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Park every ask the session's runtime holds live, so a message that waits
 * behind the turn is read (lib/session-asks.ts). Returns how many parked; null
 * when the runtime cannot be reached or predates parking.
 */
export async function parkRuntimeAsks(sessionId: string): Promise<number | null> {
  try {
    const resolved = await resolveSessionRuntimeEndpoint(sessionId);
    if (!resolved) return null;
    const res = await sessionRuntimeFetch(resolved.endpoint, 'POST', runtimeVerbPaths.parkAsks, {});
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { parked?: unknown } | null;
    return typeof body?.parked === 'number' ? body.parked : 0;
  } catch {
    return null;
  }
}

/** Dismiss a question the runtime still holds live. A parked one answers 404, which is fine: it is closed here. */
export async function rejectRuntimeQuestion(sessionId: string, requestId: string): Promise<RuntimeAskOutcome> {
  try {
    const resolved = await resolveSessionRuntimeEndpoint(sessionId);
    if (!resolved) return 'unreachable';
    const res = await sessionRuntimeFetch(resolved.endpoint, 'POST', runtimeVerbPaths.questionReject(requestId), {});
    if (res.ok) return 'released';
    return res.status === 404 ? 'not_waiting' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
