import { getClient } from '../../core/runtime/client';
import type { PermissionRuleset } from '../../core/runtime/runtime-types';
import { unwrap } from './shared';

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

/**
 * The runtime's answer for a request it no longer holds: another tab, the
 * allow-everything flow or the auto-approve backstop replied first, so the
 * request was resolved and dropped server-side. That is an expected state, not
 * an error — resolving here lets the caller drop the local pending card instead
 * of throwing into an unhandled rejection (the mechanism that paged Sentry as
 * `Permission request not found: per_<id>`). Matches both runtimes' wording
 * (opencode capitalizes the phrase; the pi harness answers lowercase) and only
 * for the reply route's own 404, so an unrelated not-found still throws.
 */
function permissionAlreadyAnswered(result: { error?: unknown; response?: Response }): boolean {
  if (result.response?.status !== 404) return false;
  const err = result.error;
  if (typeof err === 'string') {
    return err.toLowerCase().includes('permission request not found');
  }
  if (!err || typeof err !== 'object') return false;
  const rec = err as Record<string, unknown>;
  const data =
    rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : undefined;
  const message = data?.message ?? rec.message ?? rec.error ?? '';
  return String(message).toLowerCase().includes('permission request not found');
}

async function sendPermissionReply(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  const client = getClient();
  const result = await client.permission.reply({ requestID: requestId, reply, message });
  if (permissionAlreadyAnswered(result)) return;
  unwrap(result);
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

/** The permission types opencode gates today (mirrors the web's
 * PERMISSION_LABELS keys). Enumerated explicitly IN ADDITION to the `*`
 * wildcard rule so "allow all" holds even if the runtime's rule matcher treats
 * the permission NAME as an exact key rather than a glob. */
const KNOWN_PERMISSION_TYPES = [
  'bash',
  'edit',
  'write',
  'read',
  'webfetch',
  'mcp',
  'doom_loop',
] as const;

/**
 * "Allow everything for the rest of this session": writes a blanket allow
 * ruleset onto the opencode SESSION (the same per-session ledger an `always`
 * reply appends to), so subsequent asks are answered server-side — the grant
 * survives the tab closing, unlike a client-side auto-approver. Strictly
 * broader than any rules the session accumulated before, so replacing them
 * is safe. Pair with replying `once` to the currently-pending request(s);
 * this only stops FUTURE asks.
 */
export async function allowAllPermissionsForSession(sessionID: string): Promise<void> {
  const client = getClient();
  const ruleset: PermissionRuleset = [
    { permission: '*', pattern: '*', action: 'allow' },
    ...KNOWN_PERMISSION_TYPES.map((permission) => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
  ];
  const result = await client.session.update({ sessionID, permission: ruleset });
  unwrap(result);
}

/** Undo `allowAllPermissionsForSession`: clear the session ruleset so the
 * project/config permission rules apply again. */
export async function resetSessionPermissions(sessionID: string): Promise<void> {
  const client = getClient();
  const result = await client.session.update({ sessionID, permission: [] });
  unwrap(result);
}

export async function replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
  const client = getClient();
  const result = await client.question.reply({ requestID: requestId, answers });
  unwrap(result);
}

export async function rejectQuestion(requestId: string): Promise<void> {
  const client = getClient();
  const result = await client.question.reject({ requestID: requestId });
  unwrap(result);
}

// useSessionPolling was removed — SSE reconnects within <3s making 2s HTTP
// polling redundant. All session status + message updates are driven by SSE
// events via the sync store. See SSE-FIRST-MIGRATION-PLAN.md Phase 1d.
