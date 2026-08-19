// What a 403 SAYS. Pure — no DB, no request, no Hono context beyond the
// HTTPException it builds — and deliberately its own module rather than part of
// `authorize.ts`: several route tests replace the engine wholesale with
// `mock.module`, so every name a non-test module imports from it is a name those
// stubs must also declare. The wording policy has no reason to live behind that.

import { HTTPException } from 'hono/http-exception';

const MFA_DENIAL_MESSAGE =
  'This account requires multi-factor authentication. Verify your second factor and retry.';

/**
 * The message for a denial whose REASON — not the action — names what the
 * caller has to change. Returns null when the reason carries no
 * caller-actionable meaning, so the caller keeps its own action-shaped wording.
 *
 * This exists because a denial's reason is the only thing that can distinguish
 * WHICH constraint fired. `authorizeV2` folds three independent limits into one
 * boolean — the human's project role, the agent session's `kortix_cli` grant,
 * and an activated service account's assigned role — and a caller that
 * re-derives the cause from a second `authorize()` probe cannot separate them.
 * Guessing "your role is too low" at an account owner whose AGENT grant denied
 * the call sends them to a remedy that can never work.
 *
 * Naming the constraint class is not a policy oracle. The caller already holds
 * the credential whose own scope produced the denial, and the action is the one
 * it just requested — neither discloses anything about the account's wider
 * permission model, who else holds what, or which other actions would succeed.
 */
export function denialReasonMessage(action: string, reason?: string): string | null {
  switch (reason) {
    case 'account_mfa_required':
      return MFA_DENIAL_MESSAGE;
    case 'agent_scope_insufficient':
      // The agent-session token's own grant denied it, at any role. Mirrors the
      // wording assertAgentScope already uses for the same constraint.
      return `This agent session is not granted "${action}". Add it to the agent's kortix_cli in kortix.yaml and merge the change.`;
    case 'service_account_scope_insufficient':
      // The session authorizes AS the agent's service account (an admin gave it
      // a standing role), so the launching user's role is irrelevant here.
      return `This agent runs as its own service account, and the role assigned to it does not allow "${action}". Ask an account admin to update that role.`;
    case 'token_out_of_scope':
      return 'This token is scoped to a single project and cannot be used for this request.';
    case 'resource_scope_insufficient':
      return 'You are not granted access to this resource.';
    default:
      return null;
  }
}

/**
 * Turn a denial into the HTTPException the route layer surfaces. Exported for
 * unit tests.
 *
 * Reason-specific wording comes from `denialReasonMessage`; everything else
 * falls back to a plain humanized message for the action. `account_mfa_required`
 * additionally carries a machine-readable `code` because the web client keys
 * its step-up dialog on it (the SDK's ApiError already lifts `code` from error
 * bodies).
 */
export function buildDenialError(action: string, reason?: string): HTTPException {
  if (reason === 'account_mfa_required') {
    return new HTTPException(403, {
      message: MFA_DENIAL_MESSAGE,
      res: new Response(
        JSON.stringify({ error: MFA_DENIAL_MESSAGE, code: 'account_mfa_required' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    });
  }
  return new HTTPException(403, {
    message: denialReasonMessage(action, reason) ?? humanizePermissionDenial(action),
  });
}

/**
 * Map action codes (`project.create`, `member.invite`, …) to a sentence
 * the user can act on. Unknown codes get a generic phrase with the code
 * suffixed for support visibility. Keep this list short — only the
 * actions that actually show up in user-visible 403s.
 */
function humanizePermissionDenial(action: string): string {
  const verb = ACTION_VERBS[action];
  if (verb) return `You don't have permission to ${verb}.`;
  // Generic fallback. Suffix the code so support can still identify
  // which gate fired without needing server logs.
  return `You don't have permission to perform this action (${action}).`;
}

const ACTION_VERBS: Record<string, string> = {
  // Projects
  'project.create': 'create projects',
  'project.write': 'change this project',
  'project.delete': 'delete projects',
  // Project members
  'project.members.manage': 'manage project members',
  // Account
  'account.write': 'change account settings',
  'account.delete': 'delete this account',
  // Members
  'member.invite': 'invite members',
  'member.remove': 'remove members',
  'member.update': 'change member roles',
  'member.read': 'view members',
  'member.super_admin.grant': 'grant super-admin',
  'member.super_admin.revoke': 'revoke super-admin',
  // Groups
  'group.create': 'create groups',
  'group.update': 'change groups',
  'group.delete': 'delete groups',
  'group.read': 'view groups',
  'group.members.manage': 'manage group members',
  // Audit
  'audit.read': 'view the audit log',
  'audit.export': 'export audit events',
  // Tokens
  'token.read': 'view personal access tokens',
  'token.revoke': 'revoke personal access tokens',
  // Billing
  'billing.read': 'view billing',
  'billing.write': 'change billing',
};
