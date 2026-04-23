import type { Context, MiddlewareHandler } from 'hono';
import type { Database } from '@kortix/db';

import { NotAuthorizedError } from '../teams/domain/errors';
import type { UserTeamContext } from '../teams/services/access';
import type { SandboxRef } from '../teams/domain/types';

import type { Scope } from './catalog';
import { SCOPE_CATALOG } from './catalog';
import { can } from './can';

export async function assertScope(
  db: Database,
  ctx: UserTeamContext,
  sandbox: SandboxRef,
  scope: Scope,
): Promise<void> {
  const allowed = await can(db, ctx, sandbox, scope);
  if (!allowed) {
    throw new NotAuthorizedError(
      `Missing permission: ${SCOPE_CATALOG[scope].label} (${scope})`,
    );
  }
}

export interface RequireScopeDeps {
  db: Database;
  loadContext: (c: Context) => Promise<UserTeamContext>;
  loadSandbox: (c: Context, ctx: UserTeamContext) => Promise<SandboxRef>;
  attach?: (
    c: Context,
    payload: { ctx: UserTeamContext; sandbox: SandboxRef },
  ) => void;
}

export function requireScope(
  scope: Scope,
  deps: RequireScopeDeps,
): MiddlewareHandler {
  return async (c, next) => {
    const ctx = await deps.loadContext(c);
    const sandbox = await deps.loadSandbox(c, ctx);
    await assertScope(deps.db, ctx, sandbox, scope);
    deps.attach?.(c, { ctx, sandbox });
    await next();
  };
}
