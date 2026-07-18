import { accountModelPreferences, projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';

// Persistent store for account-scoped default model preferences. Drives the
// server-side resolution of the synthetic `auto` model in the LLM gateway:
//   per-agent default (scope='agent', key=agent_name) → project default
//   (scope='project', key=project_id) → account default (scope='account') →
//   platform default.
// Stored `model` values are gateway wire models (bare managed id like 'glm-5.2',
// a BYOK 'provider/model', or 'codex/<id>') — never the synthetic `auto` and
// never the opencode-only `kortix/` prefix.

export type ModelPreferenceScope = 'account' | 'agent' | 'project';

// Account-wide is the only scope that pins scope_key to ''. Agent (key=agent_name)
// and project (key=project_id) both carry a caller-supplied key; the unique index
// (account_id, scope, scope_key) keeps them from colliding.
function preferenceScopeKey(scope: ModelPreferenceScope, scopeKey?: string): string {
  return scope === 'account' ? '' : (scopeKey ?? '');
}

export interface AccountModelDefaults {
  /** Account-wide default wire model, or null when unset. */
  account: string | null;
  /** Per-agent default wire models, keyed by agent name. */
  agents: Record<string, string>;
  /** Per-project default wire models, keyed by project id. */
  projects: Record<string, string>;
}

export async function getAccountModelDefaults(accountId: string): Promise<AccountModelDefaults> {
  const rows = await db
    .select({
      scope: accountModelPreferences.scope,
      scopeKey: accountModelPreferences.scopeKey,
      model: accountModelPreferences.model,
    })
    .from(accountModelPreferences)
    .where(eq(accountModelPreferences.accountId, accountId));

  const defaults: AccountModelDefaults = { account: null, agents: {}, projects: {} };
  for (const row of rows) {
    if (row.scope === 'account') defaults.account = row.model;
    else if (row.scope === 'agent' && row.scopeKey) defaults.agents[row.scopeKey] = row.model;
    else if (row.scope === 'project' && row.scopeKey) defaults.projects[row.scopeKey] = row.model;
  }
  return defaults;
}

export async function upsertAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string;
  model: string;
  updatedBy?: string | null;
  /** Seed-only: skip the write when a row already exists for this scope (first-connect auto-seed). */
  onlyIfAbsent?: boolean;
}): Promise<void> {
  const now = new Date();
  const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
  if (params.onlyIfAbsent) {
    await db
      .insert(accountModelPreferences)
      .values({
        accountId: params.accountId,
        scope: params.scope,
        scopeKey,
        model: params.model,
        updatedBy: params.updatedBy ?? null,
      })
      .onConflictDoNothing({
        target: [
          accountModelPreferences.accountId,
          accountModelPreferences.scope,
          accountModelPreferences.scopeKey,
        ],
      });
    return;
  }
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
      set: { model: params.model, updatedBy: params.updatedBy ?? null, updatedAt: now },
    });
}

export async function deleteAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string;
}): Promise<void> {
  const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
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
 * The agent + per-session model a gateway principal's session is bound to.
 * `principal.sessionId === sandbox_id === project_sessions.session_id` (the PK)
 * by construction, so we look up the row by that key.
 *
 * Also carries the owning project's `metadata.default_agent` mirror
 * (`projectDefaultAgent`) so callers can resolve the non-binding `'default'`
 * sentinel to the project's actually-declared default agent — see
 * `chooseEffectiveAgent` (llm-gateway/resolution/effective.ts) and its use in
 * default-model.ts's `cachedSessionAgent`. A session's `agent_name` column
 * lands on the `'default'` sentinel whenever session creation didn't resolve a
 * concrete name (see `createProjectSession` in projects/lib/sessions.ts), most
 * commonly because `project.metadata.default_agent` wasn't populated even
 * though the project's kortix.yaml declares one — without this fallback, an
 * agent-scope model pin keyed by that declared name is silently never applied.
 */
export async function getSessionAgentContext(
  sessionId: string,
): Promise<{ agentName: string; opencodeModel: string | null; projectDefaultAgent: string | null } | null> {
  const [row] = await db
    .select({
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
      projectMetadata: projects.metadata,
    })
    .from(projectSessions)
    .leftJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const metadata = row.metadata as Record<string, unknown> | null;
  const opencodeModel =
    metadata && typeof metadata.opencode_model === 'string' ? metadata.opencode_model : null;
  const projectMetadata = row.projectMetadata as Record<string, unknown> | null;
  const projectDefaultAgent =
    projectMetadata && typeof projectMetadata.default_agent === 'string' && projectMetadata.default_agent.trim()
      ? projectMetadata.default_agent.trim()
      : null;
  return { agentName: row.agentName, opencodeModel, projectDefaultAgent };
}
