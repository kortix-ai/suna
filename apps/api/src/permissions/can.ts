import type { Database } from '@kortix/db';

import type { UserTeamContext } from '../teams/services/access';
import type { SandboxRef } from '../teams/domain/types';

import type { Scope } from './catalog';
import {
  effectiveScopes,
  resolveRoleSync,
  scopesForEffectiveRole,
  type EffectiveRole,
} from './resolver';

export async function can(
  db: Database,
  ctx: UserTeamContext,
  sandbox: SandboxRef,
  scope: Scope,
): Promise<boolean> {
  const scopes = await effectiveScopes(db, ctx, sandbox);
  return scopes.has(scope);
}

export function canSync(
  ctx: UserTeamContext,
  sandbox: SandboxRef,
  sandboxMembership: boolean,
  scope: Scope,
): boolean {
  const role = resolveRoleSync(ctx, sandbox, sandboxMembership);
  return scopesForEffectiveRole(role).has(scope);
}

export function hasAnyScope(
  scopes: ReadonlySet<Scope>,
  ...required: Scope[]
): boolean {
  return required.some((s) => scopes.has(s));
}

export function hasAllScopes(
  scopes: ReadonlySet<Scope>,
  ...required: Scope[]
): boolean {
  return required.every((s) => scopes.has(s));
}

export type { EffectiveRole };
