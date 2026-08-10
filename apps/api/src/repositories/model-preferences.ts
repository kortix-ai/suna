import { accountModelPreferences, projectSessions, projects } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';

// Persistent store for account-scoped default model preferences. Drives the
// server-side resolution of the synthetic `auto` model in the LLM gateway:
//   per-agent default (scope='agent', key=agent_name) → workspace default
//   workspace default (persisted scope='project', key=project_id) → account default →
//   platform default.
// Stored `model` values are gateway wire models (bare managed id like 'glm-5.2',
// a BYOK 'provider/model', or 'codex/<id>') — never the synthetic `auto` and
// never the opencode-only `kortix/` prefix.
//
// AGENT-SCOPE ROWS ARE WORKSPACE-SCOPED (see the `project_id` doc comment on
// `accountModelPreferences` in packages/db/src/schema/kortix.ts for the full
// migration story). Agents are declared per-workspace. A pin for agent 'kortix'
// set from workspace A must never apply to workspace B's unrelated agent.
// Every caller that reads or writes a scope='agent' preference supplies the
// workspace id it acts on.
// on. `project_id IS NULL` rows are PRE-migration/legacy pins: they keep
// applying as an account-wide fallback to every workspace that has not set its
// own workspace-scoped pin for that agent name. The system never rewrites it.

export type ModelPreferenceScope = 'account' | 'agent' | 'project';

// Account-wide is the only scope that pins scope_key to ''. Agent (key=agent_name)
// and workspace (persisted scope='project', key=project_id) carry a caller-supplied key. The unique index
// (account_id, scope, scope_key) keeps them from colliding.
function preferenceScopeKey(scope: ModelPreferenceScope, scopeKey?: string): string {
  return scope === 'account' ? '' : (scopeKey ?? '');
}

export interface AccountModelDefaults {
  /** Account-wide default wire model, or null when unset. */
  account: string | null;
  /**
   * Per-agent default wire models, keyed by agent name — resolved for the ONE
   * `workspaceId` passed to `getAccountModelDefaults` (or, if omitted, the
   * legacy/global fallback pins only). A workspace-scoped pin always wins over
   * a legacy global pin for the same agent name.
   */
  agents: Record<string, string>;
  /** Per-workspace default wire models, keyed by workspace id. */
  workspaces: Record<string, string>;
}

/**
 * `workspaceId` scopes which agent-name pins are visible in the returned
 * `agents` map: legacy `project_id IS NULL` rows always apply (the
 * account-wide fallback), and — when `workspaceId` is supplied — that
 * workspace's own pins are layered on top, overriding the legacy fallback for
 * any agent name both define. Omitting `workspaceId` returns ONLY the legacy
 * fallback, never another workspace's pins. This is the safe default without
 * workspace context.
 */
export async function getAccountModelDefaults(
  accountId: string,
  workspaceId?: string,
): Promise<AccountModelDefaults> {
  const rows = await db
    .select({
      scope: accountModelPreferences.scope,
      scopeKey: accountModelPreferences.scopeKey,
      workspaceId: accountModelPreferences.workspaceId,
      model: accountModelPreferences.model,
    })
    .from(accountModelPreferences)
    .where(eq(accountModelPreferences.accountId, accountId));

  const defaults: AccountModelDefaults = { account: null, agents: {}, workspaces: {} };
  for (const row of rows) {
    if (row.scope === 'account') defaults.account = row.model;
    else if (row.scope === 'project' && row.scopeKey) defaults.workspaces[row.scopeKey] = row.model;
    else if (row.scope === 'agent' && row.scopeKey && row.workspaceId == null) {
      defaults.agents[row.scopeKey] = row.model; // legacy/global fallback
    }
  }
  if (workspaceId) {
    // Second pass so a workspace-scoped pin always overrides the legacy
    // fallback set above, regardless of row order.
    for (const row of rows) {
      if (row.scope === 'agent' && row.scopeKey && row.workspaceId === workspaceId) {
        defaults.agents[row.scopeKey] = row.model;
      }
    }
  }
  return defaults;
}

export async function upsertAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string;
  /** scope='agent' only — scopes the pin to this one workspace's agent. */
  workspaceId?: string | null;
  model: string;
  updatedBy?: string | null;
  /** Seed-only: skip the write when a row already exists for this scope (first-connect auto-seed). */
  onlyIfAbsent?: boolean;
}): Promise<void> {
  const now = new Date();
  const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
  const workspaceId = params.scope === 'agent' ? (params.workspaceId ?? null) : null;
  // Two partial unique indexes replace the old single one (see the schema doc
  // comment): rows with a project_id use the workspace-scoped arbiter index,
  // everything else, including the stable persisted project scope and legacy global agent
  // pins) uses the global one. The ON CONFLICT target must repeat the exact
  // predicate for Postgres to infer a PARTIAL index as the arbiter.
  const target = workspaceId
    ? [
        accountModelPreferences.accountId,
        accountModelPreferences.scope,
        accountModelPreferences.scopeKey,
        accountModelPreferences.workspaceId,
      ]
    : [accountModelPreferences.accountId, accountModelPreferences.scope, accountModelPreferences.scopeKey];
  const targetWhere = workspaceId ? sql`project_id is not null` : sql`project_id is null`;
  if (params.onlyIfAbsent) {
    await db
      .insert(accountModelPreferences)
      .values({
        accountId: params.accountId,
        scope: params.scope,
        scopeKey,
        workspaceId,
        model: params.model,
        updatedBy: params.updatedBy ?? null,
      })
      .onConflictDoNothing({ target, where: targetWhere });
    return;
  }
  await db
    .insert(accountModelPreferences)
    .values({
      accountId: params.accountId,
      scope: params.scope,
      scopeKey,
      workspaceId,
      model: params.model,
      updatedBy: params.updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target,
      targetWhere,
      set: { model: params.model, updatedBy: params.updatedBy ?? null, updatedAt: now },
    });
}

export async function deleteAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string;
  /** scope='agent' only — deletes this workspace's pin and no other pin. */
  workspaceId?: string | null;
}): Promise<void> {
  const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
  const workspaceId = params.scope === 'agent' ? (params.workspaceId ?? null) : null;
  await db
    .delete(accountModelPreferences)
    .where(
      and(
        eq(accountModelPreferences.accountId, params.accountId),
        eq(accountModelPreferences.scope, params.scope),
        eq(accountModelPreferences.scopeKey, scopeKey),
        workspaceId ? eq(accountModelPreferences.workspaceId, workspaceId) : isNull(accountModelPreferences.workspaceId),
      ),
    );
}

/**
 * The agent + per-session model a gateway principal's session is bound to.
 * `principal.sessionId === sandbox_id === project_sessions.session_id` (the PK)
 * by construction, so we look up the row by that key.
 *
 * Also carries the owning workspace's `metadata.default_agent` mirror
 * (`workspaceDefaultAgent`) so callers can resolve the non-binding `'default'`
 * sentinel to the workspace's declared default agent. See
 * `chooseEffectiveAgent` (llm-gateway/resolution/effective.ts) and its use in
 * default-model.ts's `cachedSessionAgent`. A session's `agent_name` column
 * lands on the `'default'` sentinel whenever session creation didn't resolve a
 * concrete name. This occurs when `workspace.metadata.default_agent` was not
 * populated even though the workspace's kortix.yaml declares one. Without this fallback, an
 * agent-scope model pin keyed by that declared name is silently never applied.
 */
export async function getSessionAgentContext(
  sessionId: string,
): Promise<{ agentName: string; opencodeModel: string | null; workspaceDefaultAgent: string | null } | null> {
  const [row] = await db
    .select({
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
      workspaceMetadata: projects.metadata,
    })
    .from(projectSessions)
    .leftJoin(projects, eq(projects.workspaceId, projectSessions.workspaceId))
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  const metadata = row.metadata as Record<string, unknown> | null;
  const opencodeModel =
    metadata && typeof metadata.opencode_model === 'string' ? metadata.opencode_model : null;
  const workspaceMetadata = row.workspaceMetadata as Record<string, unknown> | null;
  const workspaceDefaultAgent =
    workspaceMetadata && typeof workspaceMetadata.default_agent === 'string' && workspaceMetadata.default_agent.trim()
      ? workspaceMetadata.default_agent.trim()
      : null;
  return { agentName: row.agentName, opencodeModel, workspaceDefaultAgent };
}
