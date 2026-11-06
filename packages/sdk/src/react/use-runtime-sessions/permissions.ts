import { activeRuntimeAction, runtimeActionError, runtimeActionPaths } from '../../core/session/runtime-actions';

/** Throw the action route's refusal; a 2xx passes. */
async function ensureActionOk(response: Response, what: string): Promise<void> {
  if (!response.ok) throw await runtimeActionError(response, what);
}

// ============================================================================
// Permission & Question Reply (direct SDK calls, not hooks)
// ============================================================================

/**
 * One reply in flight per permission request id. Every reply affordance funnels
 * into `replyToPermission` — the composer card, the tool-card inline prompt,
 * the "Allow everything" flow and the client-side auto-approve backstop — and
 * two of them can fire for the same request (prod 2026-10-12: a click and the
 * backstop raced; the runtime answered the first POST and 404'd the second). A
 * joiner shares the first send instead of racing it.
 */
const repliesInFlight = new Map<string, Promise<void>>();

async function sendPermissionReply(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  const answered = await activeRuntimeAction('POST', runtimeActionPaths.permissionReply(requestId), {
    reply,
    ...(message !== undefined ? { message } : {}),
  });
  // Only the reply route's own 404 ("no such permission request") means another
  // reply resolved it: another tab, the allow-everything flow or the auto-approve
  // backstop replied first. Any other refusal — the proxy's lost sandbox included —
  // reaches the caller, so the card stays for a decision that never landed.
  if (answered.status === 404) {
    const body = (await answered.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && /no such permission request/i.test(body.error)) return;
  }
  await ensureActionOk(answered, 'Answering the permission request failed');
}

export async function replyToPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  const inFlight = repliesInFlight.get(requestId);
  if (inFlight) return inFlight;
  const send = sendPermissionReply(requestId, reply, message).finally(() => {
    repliesInFlight.delete(requestId);
  });
  repliesInFlight.set(requestId, send);
  return send;
}

/**
 * "Allow everything for the rest of this session": writes the blanket `*`
 * grant onto the session (the same per-session ledger an `always` reply
 * appends to), so subsequent asks are answered server-side — the grant
 * survives the tab closing, unlike a client-side auto-approver. Strictly
 * broader than any rules the session accumulated before, so replacing them
 * is safe. Pair with replying `once` to the currently-pending request(s);
 * this only stops FUTURE asks.
 */
export async function allowAllPermissionsForSession(sessionID: string): Promise<void> {
  const granted = await activeRuntimeAction('PUT', runtimeActionPaths.grants(sessionID), { grants: ['*'] });
  return ensureActionOk(granted, 'Allowing every permission failed');
}

/** Undo `allowAllPermissionsForSession`: clear the session grants so the
 * project/config permission rules apply again. */
export async function resetSessionPermissions(sessionID: string): Promise<void> {
  const cleared = await activeRuntimeAction('PUT', runtimeActionPaths.grants(sessionID), { grants: [] });
  return ensureActionOk(cleared, 'Clearing the session grants failed');
}

export async function replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
  const answered = await activeRuntimeAction('POST', runtimeActionPaths.questionReply(requestId), { answers });
  return ensureActionOk(answered, 'Answering the question failed');
}

export async function rejectQuestion(requestId: string): Promise<void> {
  const dismissed = await activeRuntimeAction('POST', runtimeActionPaths.questionReject(requestId));
  return ensureActionOk(dismissed, 'Dismissing the question failed');
}

// useSessionPolling was removed — SSE reconnects within <3s making 2s HTTP
// polling redundant. All session status + message updates are driven by SSE
// events via the sync store. See SSE-FIRST-MIGRATION-PLAN.md Phase 1d.
