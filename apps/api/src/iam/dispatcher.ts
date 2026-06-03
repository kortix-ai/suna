// Public engine entry points used everywhere outside the iam/ module.
// The wrapper survives because:
//   - assertAuthorized turns "denied" into an HTTPException so V2
//     itself doesn't need to know about Hono.
//   - listAccessibleResources collapses non-project resource types
//     to mode:'none' (V2 only lists projects).
//   - The route layer + cache helper + iam/index.ts all pin their
//     imports here; consolidating preserves that import path.

import { HTTPException } from 'hono/http-exception';
import type {
  AccessibleResources,
  AuthorizeResult,
  AuthorizeTarget,
  RequestContext,
} from './types';
import type { ResourceType } from './actions';
import { authorizeV2, listAccessibleProjectsV2 } from './engine-v2';

export async function authorize(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AuthorizeResult> {
  return authorizeV2(userId, accountId, action, target, actingTokenId, requestCtx);
}

export async function assertAuthorized(
  userId: string,
  accountId: string,
  action: string,
  target?: AuthorizeTarget,
  actingTokenId?: string,
  requestCtx?: RequestContext,
): Promise<void> {
  const result = await authorize(userId, accountId, action, target, actingTokenId, requestCtx);
  if (!result.allowed) {
    // User-facing 403 message: "You don't have permission to create
    // projects." Falls back to a generic "perform this action" when
    // the action isn't in the verb map, with the action code suffixed
    // in parens so support / dev tooling can still identify it. The
    // reason code (account_role_insufficient, etc.) is intentionally
    // dropped — it's diagnostic, not actionable for end users.
    throw new HTTPException(403, {
      message: humanizePermissionDenial(action),
    });
  }
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
  'project.deploy': 'deploy this project',
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

export async function listAccessibleResources(
  userId: string,
  accountId: string,
  action: string,
  resourceType: ResourceType,
  actingTokenId?: string,
  requestCtx: RequestContext = {},
): Promise<AccessibleResources> {
  // V2 only supports project listings — sandboxes/triggers/channels are
  // reached via their owning project, never listed standalone.
  if (resourceType !== 'project') return { mode: 'none' };

  return listAccessibleProjectsV2(
    userId,
    accountId,
    action,
    actingTokenId,
    requestCtx,
  );
}
