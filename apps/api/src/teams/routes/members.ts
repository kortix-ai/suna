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
import { setSandboxMemberSpendCap } from '../repositories/members';
import { ValidationError } from '../domain/errors';
import type { AccountRole } from '../domain/types';
import { listPendingInvitesForSandbox } from '../repositories/invites';
import { respondWithDomainError } from './http-errors';
import {
  ALL_SCOPES,
  SCOPE_CATALOG,
  ROLE_SCOPES,
  can,
  invalidateOverrides,
  isScope,
  listOverrides,
  resolveRole,
  scopesByGroup,
  setOverride,
  type Scope,
} from '../../permissions';

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
  scope: Scope = 'members:invite',
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
    throw new NotAuthorizedError('You do not have access to this instance');
  }
  const allowed = await can(deps.db, ctx, sandbox, scope);
  if (!allowed) {
    throw new NotAuthorizedError(
      `Missing permission: ${SCOPE_CATALOG[scope].label}`,
    );
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
            monthly_spend_cap_cents: m.monthlySpendCapCents,
            current_period_cents: m.currentPeriodCents,
          })),
          pending_invites: pendingInvites.map((i) => ({
            invite_id: i.inviteId,
            email: i.email,
            role: i.initialRole,
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
      const { userId, sandbox } = await resolveManagerSandbox(c, deps, 'members:invite');
      const body = await c.req.json().catch(() => ({}));
      const inviterEmail = (c.get('userEmail') as string | undefined) || null;

      const rawRole = body?.role;
      const role: 'admin' | 'member' | undefined =
        rawRole === 'admin' || rawRole === 'member' ? rawRole : undefined;

      const { invite, status } = await createInvite(deps.db, {
        sandboxId: sandbox.sandboxId,
        accountId: sandbox.accountId,
        sandboxName: sandbox.name,
        email: String(body?.email ?? ''),
        invitedBy: userId,
        inviterEmail,
        role,
      });

      return c.json({
        success: true,
        data: {
          status: status === 'reused' ? 'invited' : 'invited',
          email: invite?.email ?? null,
          invite_id: invite?.inviteId ?? null,
          role: invite?.initialRole ?? null,
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] invite error:');
    }
  });

  router.delete('/:sandboxId/members/:userId', async (c) => {
    try {
      const { sandbox } = await resolveManagerSandbox(c, deps, 'members:remove');
      await removeMember(
        deps.db,
        { sandboxId: sandbox.sandboxId, accountId: sandbox.accountId },
        c.req.param('userId'),
      );
      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] remove error:');
    }
  });

  router.patch('/:sandboxId/members/:userId', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const hasRole = typeof body?.role === 'string';
      const hasCap = 'monthly_spend_cap_cents' in (body ?? {});

      if (!hasRole && !hasCap) {
        throw new ValidationError('role or monthly_spend_cap_cents is required');
      }

      const requiredScope: Scope = hasRole ? 'members:change_role' : 'members:set_cap';
      const { userId: callerUserId, sandbox } = await resolveManagerSandbox(c, deps, requiredScope);
      const targetUserId = c.req.param('userId');

      if (hasRole) {
        if (targetUserId === callerUserId) {
          throw new ValidationError('You cannot change your own role');
        }
        await changeMemberRole(deps.db, {
          accountId: sandbox.accountId,
          targetUserId,
          role: body.role as AccountRole,
        });
      }

      if (hasCap) {
        const raw = body.monthly_spend_cap_cents;
        let capCents: number | null;
        if (raw === null) {
          capCents = null;
        } else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
          capCents = Math.floor(raw);
        } else {
          throw new ValidationError(
            'monthly_spend_cap_cents must be a non-negative number or null',
          );
        }
        await setSandboxMemberSpendCap(
          deps.db,
          sandbox.sandboxId,
          targetUserId,
          capCents,
        );
      }

      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] update error:');
    }
  });

  router.get('/:sandboxId/me/scopes', async (c) => {
    try {
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
        throw new NotAuthorizedError('You do not have access to this instance');
      }
      const role = await resolveRole(deps.db, ctx, {
        sandboxId: sandbox.sandboxId,
        accountId: sandbox.accountId,
      });
      const overrides = await listOverrides(deps.db, sandbox.sandboxId, userId);
      const effectiveRole =
        role === 'platform_admin' || role === 'owner' ? 'owner'
          : role === 'admin' ? 'admin'
          : role === 'member' ? 'member'
          : null;
      const base: Scope[] = effectiveRole ? Array.from(ROLE_SCOPES[effectiveRole]) : [];
      const effectiveSet = new Set<Scope>(base);
      for (const s of overrides.grants) effectiveSet.add(s);
      for (const s of overrides.revokes) effectiveSet.delete(s);

      return c.json({
        success: true,
        data: {
          sandbox_id: sandbox.sandboxId,
          role: effectiveRole,
          scopes: Array.from(effectiveSet),
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] my scopes error:');
    }
  });

  router.get('/:sandboxId/members/:userId/scopes', async (c) => {
    try {
      const { sandbox } = await resolveManagerSandbox(c, deps, 'members:change_role');
      const targetUserId = c.req.param('userId');
      const targetCtx = await loadUserTeamContext(
        deps.db,
        targetUserId,
        await deps.resolveAccountId(targetUserId),
      );
      const role = await resolveRole(deps.db, targetCtx, {
        sandboxId: sandbox.sandboxId,
        accountId: sandbox.accountId,
      });
      const overrides = await listOverrides(deps.db, sandbox.sandboxId, targetUserId);

      const effectiveRole =
        role === 'platform_admin' || role === 'owner' ? 'owner'
          : role === 'admin' ? 'admin'
          : role === 'member' ? 'member'
          : null;

      const baseScopes: Scope[] = effectiveRole ? Array.from(ROLE_SCOPES[effectiveRole]) : [];
      const grants = Array.from(overrides.grants);
      const revokes = Array.from(overrides.revokes);

      const effectiveSet = new Set<Scope>(baseScopes);
      for (const s of grants) effectiveSet.add(s);
      for (const s of revokes) effectiveSet.delete(s);

      return c.json({
        success: true,
        data: {
          sandbox_id: sandbox.sandboxId,
          user_id: targetUserId,
          role: effectiveRole,
          inherited: baseScopes,
          grants,
          revokes,
          effective: Array.from(effectiveSet),
          catalog: ALL_SCOPES.map((s) => ({
            scope: s,
            ...SCOPE_CATALOG[s],
          })),
          groups: scopesByGroup(),
        },
      });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] list scopes error:');
    }
  });

  router.patch('/:sandboxId/members/:userId/scopes', async (c) => {
    try {
      const { userId: callerUserId, sandbox } = await resolveManagerSandbox(c, deps, 'members:change_role');
      const targetUserId = c.req.param('userId');
      if (targetUserId === callerUserId) {
        throw new ValidationError('You cannot change your own scopes');
      }

      const body = await c.req.json().catch(() => ({}));
      const scopeRaw = body?.scope;
      const effectRaw = body?.effect;

      if (typeof scopeRaw !== 'string' || !isScope(scopeRaw)) {
        throw new ValidationError('scope must be a known scope key');
      }
      const effect: 'grant' | 'revoke' | null =
        effectRaw === 'grant' || effectRaw === 'revoke' ? effectRaw
          : effectRaw === null ? null
          : (() => { throw new ValidationError("effect must be 'grant', 'revoke', or null"); })();

      await setOverride(deps.db, {
        sandboxId: sandbox.sandboxId,
        userId: targetUserId,
        scope: scopeRaw,
        effect,
        grantedBy: callerUserId,
      });
      invalidateOverrides(sandbox.sandboxId, targetUserId);

      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] set scope error:');
    }
  });

  router.delete('/:sandboxId/invites/:inviteId', async (c) => {
    try {
      const { sandbox } = await resolveManagerSandbox(c, deps, 'members:invite');
      await revokeInvite(deps.db, sandbox.sandboxId, c.req.param('inviteId'));
      return c.json({ success: true });
    } catch (err) {
      return respondWithDomainError(c, err, '[MEMBERS] revoke error:');
    }
  });
  
  return router;
}

export const membersRouter = createMembersRouter();
