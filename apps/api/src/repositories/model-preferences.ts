// Default-model preferences (account / project / agent scope) + the session
// context the gateway resolver needs to apply them. The committed kortix.toml
// holds an agent's and a trigger's declarative model; THIS table holds the
// dynamic, SDK/UI-set defaults that have no home in code. The gateway resolves
// an incoming `auto` against both — most-specific scope wins. Entitlement is
// enforced by the gateway, never here.

import { and, eq } from 'drizzle-orm';
import { accountModelPreferences, projectSessions } from '@kortix/db';
import { db } from '../shared/db';

export type ModelPreferenceScope = 'account' | 'project' | 'agent';

export interface AccountModelDefaults {
  /** scope='account', scope_key='' — the personal/account default. */
  account: string | null;
  /** scope='project', keyed by projectId — overrides the account default. */
  projects: Record<string, string>;
  /** scope='agent', keyed by agentName — a dynamic override of the agent's
   *  kortix.toml [[agents]].model; overrides the project default. */
  agents: Record<string, string>;
}

/** Read all of an account's model-default rows in one query, bucketed by scope. */
export async function getAccountModelDefaults(accountId: string): Promise<AccountModelDefaults> {
  const rows = await db
    .select({
      scope: accountModelPreferences.scope,
      scopeKey: accountModelPreferences.scopeKey,
      model: accountModelPreferences.model,
    })
    .from(accountModelPreferences)
    .where(eq(accountModelPreferences.accountId, accountId));

  const out: AccountModelDefaults = { account: null, projects: {}, agents: {} };
  for (const row of rows) {
    if (row.scope === 'account') out.account = row.model;
    else if (row.scope === 'project') out.projects[row.scopeKey] = row.model;
    else if (row.scope === 'agent') out.agents[row.scopeKey] = row.model;
  }
  return out;
}

/** Set (insert-or-update) one preference. scopeKey is '' for account scope,
 *  projectId for project scope, agentName for agent scope. */
export async function upsertAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string | null;
  model: string;
  updatedBy?: string | null;
}): Promise<void> {
  const scopeKey = params.scopeKey ?? '';
  await db
    .insert(accountModelPreferences)
    .values({
      accountId: params.accountId,
      scope: params.scope,
      scopeKey,
      model: params.model,
      updatedBy: params.updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        accountModelPreferences.accountId,
        accountModelPreferences.scope,
        accountModelPreferences.scopeKey,
      ],
      set: { model: params.model, updatedBy: params.updatedBy ?? null, updatedAt: new Date() },
    });
}

/** Clear one preference (back to resolving the rest of the chain). */
export async function deleteAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string | null;
}): Promise<void> {
  const scopeKey = params.scopeKey ?? '';
  await db
    .delete(accountModelPreferences)
    .where(
      and(
        eq(accountModelPreferences.accountId, params.accountId),
        eq(accountModelPreferences.scope, params.scope),
        eq(accountModelPreferences.scopeKey, scopeKey),
      ),
    );
}

/**
 * The session-scoped context the gateway resolver needs to apply project +
 * agent defaults for an `auto` request.
 *
 * - `agentManifestModel` is the agent's kortix.toml [[agents]].model, stamped
 *   into session metadata at creation so the resolver hot path never reads git.
 * - `opencodeModel` is a hard per-session override (a trigger's model, or an
 *   explicit user pick) — when set, `auto` should never have been sent, but we
 *   surface it so callers can treat it as the top of the chain if needed.
 */
export interface SessionResolutionContext {
  agentName: string;
  projectId: string;
  agentManifestModel: string | null;
  opencodeModel: string | null;
}

export async function getSessionResolutionContext(
  sessionId: string,
): Promise<SessionResolutionContext | null> {
  const [row] = await db
    .select({
      agentName: projectSessions.agentName,
      projectId: projectSessions.projectId,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const metadata = row.metadata as Record<string, unknown> | null;
  const readStr = (k: string): string | null =>
    metadata && typeof metadata[k] === 'string' ? (metadata[k] as string) : null;
  return {
    agentName: row.agentName,
    projectId: row.projectId,
    agentManifestModel: readStr('agent_default_model'),
    opencodeModel: readStr('opencode_model'),
  };
}
