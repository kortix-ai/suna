import type { Database } from '@kortix/db';

import { isSandboxMember } from '../teams/repositories/members';
import type { UserTeamContext } from '../teams/services/access';
import type { SandboxRef } from '../teams/domain/types';

import type { Scope } from './catalog';
import { ROLE_SCOPES, type SandboxRole } from './roles';
import { getOverridesCached } from './cache';
import type { MemberScopeOverrides } from './overrides';

export type EffectiveRole = SandboxRole | 'platform_admin' | null;

export function resolveRoleSync(
  ctx: UserTeamContext,
  sandbox: SandboxRef,
  sandboxMembership: boolean,
): EffectiveRole {
  if (ctx.isPlatformAdmin) return 'platform_admin';
  if (ctx.ownerAccountIds.includes(sandbox.accountId)) return 'owner';
  if (ctx.managerAccountIds.includes(sandbox.accountId)) return 'admin';
  if (sandboxMembership) return 'member';
  return null;
}

export async function resolveRole(
  db: Database,
  ctx: UserTeamContext,
  sandbox: SandboxRef,
): Promise<EffectiveRole> {
  if (ctx.isPlatformAdmin) return 'platform_admin';
  if (ctx.ownerAccountIds.includes(sandbox.accountId)) return 'owner';
  if (ctx.managerAccountIds.includes(sandbox.accountId)) return 'admin';
  const member = await isSandboxMember(db, sandbox.sandboxId, ctx.userId);
  return member ? 'member' : null;
}

export function applyOverridesToRole(
  role: EffectiveRole,
  overrides: MemberScopeOverrides,
): Set<Scope> {
  if (role === null) return new Set<Scope>();
  const base =
    role === 'platform_admin' || role === 'owner'
      ? ROLE_SCOPES.owner
      : ROLE_SCOPES[role];
  const out = new Set<Scope>(base);
  for (const s of overrides.grants) out.add(s);
  for (const s of overrides.revokes) out.delete(s);
  return out;
}

export function scopesForEffectiveRole(role: EffectiveRole): ReadonlySet<Scope> {
  if (role === null) return EMPTY;
  if (role === 'platform_admin' || role === 'owner') return ROLE_SCOPES.owner;
  return ROLE_SCOPES[role];
}

export async function effectiveScopes(
  db: Database,
  ctx: UserTeamContext,
  sandbox: SandboxRef,
): Promise<ReadonlySet<Scope>> {
  const role = await resolveRole(db, ctx, sandbox);
  if (role === null) return EMPTY;
  if (role === 'platform_admin') return ROLE_SCOPES.owner;
  const overrides = await getOverridesCached(db, sandbox.sandboxId, ctx.userId);
  return applyOverridesToRole(role, overrides);
}

const EMPTY: ReadonlySet<Scope> = new Set<Scope>();
