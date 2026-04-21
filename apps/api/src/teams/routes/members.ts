import { Hono } from 'hono';
import { type Database } from '@kortix/db';

import { db as defaultDb } from '../../shared/db';
import { supabaseAuth as authMiddleware } from '../../middleware/auth';
import { resolveAccountId as defaultResolveAccountId } from '../../shared/resolve-account';
import type { AuthVariables } from '../../types';

import { NotAuthorizedError } from '../domain/errors';
import {
  loadSandboxForUser,
  loadUserTeamContext,
} from '../services/access';
import {
  createInvite,
  revokeInvite,
} from '../services/invites';
import {
  changeMemberRole,
  listMembers,
  removeMember,
} from '../services/membership';
import { ValidationError } from '../domain/errors';
import type { AccountRole } from '../domain/types';
import { listPendingInvitesForSandbox } from '../repositories/invites';
import { respondWithDomainError } from './http-errors';

export interface MembersRouterDeps {
  db: Database;
  resolveAccountId: (userId: string) => Promise<string>;
  useAuth: boolean;
}

const defaults: MembersRouterDeps = {
  db: defaultDb,
  resolveAccountId: defaultResolveAccountId,
  useAuth: true,
};

async function resolveManagerSandbox(
  c: any,
  deps: MembersRouterDeps,
) {
  const userId = c.get('userId') as string;
  const primaryAccountId = await deps.resolveAccountId(userId);
  const ctx = await loadUserTeamContext(deps.db, userId, primaryAccountId);
  const { sandbox, decision } = await loadSandboxForUser(
    deps.db,
    ctx,
    c.req.param('sandboxId'),
    'manage_members',
  );
  if (!decision.allowed) {
    throw new NotAuthorizedError('Only account owners or admins can manage members');
  }
  return { userId, ctx, sandbox };
}

async function resolveViewSandbox(
  c: any,
  deps: MembersRouterDeps,
) {
  const userId = c.get('userId') as string;
  const primaryAccountId = await deps.resolveAccountId(userId);
  const ctx = await loadUserTeamContext(deps.db, userId, primaryAccountId);
  const { sandbox, decision } = await loadSandboxForUser(
    deps.db,
    ctx,
    c.req.param('sandboxId'),
    'view',
  );
  if (!decision.allowed) {
    throw new NotAuthorizedError('You do not have access to this sandbox');
  }
  // can_manage is owner-only: admins can see every sandbox in their account
  // but only the owner can add/remove members and revoke invites.
  const canManage =
    ctx.isPlatformAdmin || ctx.ownerAccountIds.includes(sandbox.accountId);
  return { userId, ctx, sandbox, canManage };
}

export function createMembersRouter(
  overrides: Partial<MembersRouterDeps> = {},
): Hono<{ Variables: AuthVariables }> {
  const deps = { ...defaults, ...overrides };
  const router = new Hono<{ Variables: AuthVariables }>();

  if (deps.useAuth) router.use('/*', authMiddleware);

  router.get('/:sandboxId/members', async (c) => {
    try {
      const { userId, sandbox, canManage } = await resolveViewSandbox(c, deps);

      const [members, pendingInvites] = await Promise.all([
        listMembers(deps.db, sandbox.sandboxId, sandbox.accountId),
        listPendingInvitesForSandbox(deps.db, sandbox.sandboxId),
      ]);

      return c.json({
        success: true,
        data: {
          sandbox_id: sandbox.sandboxId,
          can_manage: canManage,
          viewer_user_id: userId,
          members: members.map((m) => ({
            user_id: m.userId,
            email: m.email,
            role: m.accountRole,
            added_by: m.addedBy,
            added_at: m.addedAt.toISOString(),
          })),
          pending_invites: pendingInvites.map((i) => ({
            invite_id: i.inviteId,
            email: i.email,
            invited_by: i.invitedBy,
            created_at: i.createdAt.toISOString(),
            expires_at: i.expiresAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] list error:');
    }
  });

  router.post('/:sandboxId/members', async (c) => {
    try {
      const { userId, sandbox } = await resolveManagerSandbox(c, deps);
      const body = await c.req.json().catch(() => ({}));
      const inviterEmail = (c.get('userEmail') as string | undefined) || null;

      const { invite, status } = await createInvite(deps.db, {
        sandboxId: sandbox.sandboxId,
        accountId: sandbox.accountId,
        sandboxName: sandbox.name,
        email: String(body?.email ?? ''),
        invitedBy: userId,
        inviterEmail,
      });

      return c.json({
        success: true,
        data: {
          status: status === 'reused' ? 'invited' : 'invited',
          email: invite?.email ?? null,
          invite_id: invite?.inviteId ?? null,
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] invite error:');
    }
  });

  router.delete('/:sandboxId/members/:userId', async (c) => {
    try {
      const { sandbox } = await resolveManagerSandbox(c, deps);
      await removeMember(deps.db, sandbox.sandboxId, c.req.param('userId'));
      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] remove error:');
    }
  });

  router.patch('/:sandboxId/members/:userId', async (c) => {
    try {
      const { userId: callerUserId, sandbox } = await resolveManagerSandbox(c, deps);
      const targetUserId = c.req.param('userId');

      if (targetUserId === callerUserId) {
        throw new ValidationError('You cannot change your own role');
      }

      const body = await c.req.json().catch(() => ({}));
      const role = body?.role as AccountRole | undefined;
      if (!role) {
        throw new ValidationError('role is required');
      }

      await changeMemberRole(deps.db, {
        accountId: sandbox.accountId,
        targetUserId,
        role,
      });
      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] role change error:');
    }
  });

  router.delete('/:sandboxId/invites/:inviteId', async (c) => {
    try {
      const { sandbox } = await resolveManagerSandbox(c, deps);
      await revokeInvite(deps.db, sandbox.sandboxId, c.req.param('inviteId'));
      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] revoke error:');
    }
  });

  return router;
}

export const membersRouter = createMembersRouter();
