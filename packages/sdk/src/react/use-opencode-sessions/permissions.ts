import type { PermissionRuleset } from '@opencode-ai/sdk/v2/client';
import { getClient } from '../../core/runtime/client';
import { unwrap } from './shared';

// ============================================================================
// Permission & Question Reply (direct SDK calls, not hooks)
// ============================================================================

export async function replyToPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  const client = getClient();
  const result = await client.permission.reply({ requestID: requestId, reply, message });
  unwrap(result);
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
