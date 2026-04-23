import { and, eq } from 'drizzle-orm';
import { sandboxMemberScopes, type Database } from '@kortix/db';

import { isScope, type Scope } from './catalog';

export interface MemberScopeOverrides {
  grants: ReadonlySet<Scope>;
  revokes: ReadonlySet<Scope>;
}

const EMPTY_OVERRIDES: MemberScopeOverrides = {
  grants: new Set<Scope>(),
  revokes: new Set<Scope>(),
};

export async function listOverrides(
  db: Database,
  sandboxId: string,
  userId: string,
): Promise<MemberScopeOverrides> {
  const raw = await db
    .select({ scope: sandboxMemberScopes.scope, effect: sandboxMemberScopes.effect })
    .from(sandboxMemberScopes)
    .where(
      and(
        eq(sandboxMemberScopes.sandboxId, sandboxId),
        eq(sandboxMemberScopes.userId, userId),
      ),
    );

  const rows = Array.isArray(raw) ? raw : [];
  const grants = new Set<Scope>();
  const revokes = new Set<Scope>();
  for (const row of rows) {
    if (!row || typeof row.scope !== 'string' || !isScope(row.scope)) continue;
    (row.effect === 'grant' ? grants : revokes).add(row.scope);
  }
  return { grants, revokes };
}

export async function setOverride(
  db: Database,
  input: {
    sandboxId: string;
    userId: string;
    scope: Scope;
    effect: 'grant' | 'revoke' | null;
    grantedBy: string | null;
  },
): Promise<void> {
  const { sandboxId, userId, scope, effect, grantedBy } = input;

  if (effect === null) {
    await db
      .delete(sandboxMemberScopes)
      .where(
        and(
          eq(sandboxMemberScopes.sandboxId, sandboxId),
          eq(sandboxMemberScopes.userId, userId),
          eq(sandboxMemberScopes.scope, scope),
        ),
      );
    return;
  }

  await db
    .insert(sandboxMemberScopes)
    .values({ sandboxId, userId, scope, effect, grantedBy })
    .onConflictDoUpdate({
      target: [
        sandboxMemberScopes.sandboxId,
        sandboxMemberScopes.userId,
        sandboxMemberScopes.scope,
      ],
      set: { effect, grantedBy, grantedAt: new Date() },
    });
}

export { EMPTY_OVERRIDES };
