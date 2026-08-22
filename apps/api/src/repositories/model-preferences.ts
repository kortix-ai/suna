import { accountModelPreferences, projectSessions, projects } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';

// Persistent store for account-scoped default model preferences. Drives the
// server-side resolution of the synthetic `auto` model in the LLM gateway:
//   per-agent default (scope='agent', key=agent_name) → project default
//   (scope='project', key=project_id) → account default (scope='account') →
//   platform default.
// Stored `model` values are gateway wire models (bare managed id like 'glm-5.2',
// a BYOK 'provider/model', or 'codex/<id>') — never the synthetic `auto` and
// never the opencode-only `kortix/` prefix.
//
// AGENT-SCOPE ROWS ARE PROJECT-SCOPED (see the `project_id` doc comment on
// `accountModelPreferences` in packages/db/src/schema/kortix.ts for the full
// migration story). Agents are declared per-project (each project's own
// kortix.yaml), so a pin for agent 'kortix' set from project A must never
// apply to project B's unrelated 'kortix' agent — every caller that reads or
// writes a scope='agent' preference MUST supply the project id it's acting
// on. `project_id IS NULL` rows are PRE-migration/legacy pins: they keep
// applying as an account-wide fallback to every project that hasn't set its
// OWN project-scoped pin for that agent name yet — never deleted or
// rewritten automatically, only shadowed once a project explicitly re-pins.

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
  /**
   * Per-agent default wire models, keyed by agent name — resolved for the ONE
   * `projectId` passed to `getAccountModelDefaults` (or, if omitted, the
   * legacy/global fallback pins only). A project-scoped pin always wins over
   * a legacy global pin for the same agent name.
   */
  agents: Record<string, string>;
  /** Per-project default wire models, keyed by project id. */
  projects: Record<string, string>;
}

/**
 * `projectId` scopes which agent-name pins are visible in the returned
 * `agents` map: legacy `project_id IS NULL` rows always apply (the
 * account-wide fallback), and — when `projectId` is supplied — that
 * project's OWN pins are layered on top, overriding the legacy fallback for
 * any agent name both define. Omitting `projectId` returns ONLY the legacy
 * fallback, never another project's pins (safe default with no project
 * context — see resolveDefaultModelForPrincipal's project-less principals).
 */
export async function getAccountModelDefaults(
  accountId: string,
  projectId?: string,
): Promise<AccountModelDefaults> {
  const rows = await db
    .select({
      scope: accountModelPreferences.scope,
      scopeKey: accountModelPreferences.scopeKey,
      projectId: accountModelPreferences.projectId,
      model: accountModelPreferences.model,
    })
    .from(accountModelPreferences)
    .where(eq(accountModelPreferences.accountId, accountId));

  const defaults: AccountModelDefaults = { account: null, agents: {}, projects: {} };
  for (const row of rows) {
    if (row.scope === 'account') defaults.account = row.model;
    else if (row.scope === 'project' && row.scopeKey) defaults.projects[row.scopeKey] = row.model;
    else if (row.scope === 'agent' && row.scopeKey && row.projectId == null) {
      defaults.agents[row.scopeKey] = row.model; // legacy/global fallback
    }
  }
  if (projectId) {
    // Second pass so a project-scoped pin always overrides the legacy
    // fallback set above, regardless of row order.
    for (const row of rows) {
      if (row.scope === 'agent' && row.scopeKey && row.projectId === projectId) {
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
  /** scope='agent' only — scopes the pin to this ONE project's agent. Ignored for every other scope. */
  projectId?: string | null;
  model: string;
  updatedBy?: string | null;
  /** Seed-only: skip the write when a row already exists for this scope (first-connect auto-seed). */
  onlyIfAbsent?: boolean;
}): Promise<void> {
  const now = new Date();
  const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
  const projectId = params.scope === 'agent' ? (params.projectId ?? null) : null;
  // Two partial unique indexes replace the old single one (see the schema doc
  // comment): rows with a project_id use the project-scoped arbiter index,
  // everything else (account/project scope, and legacy project-less agent
  // pins) uses the global one. The ON CONFLICT target must repeat the exact
  // predicate for Postgres to infer a PARTIAL index as the arbiter.
  const target = projectId
    ? [
        accountModelPreferences.accountId,
        accountModelPreferences.scope,
        accountModelPreferences.scopeKey,
        accountModelPreferences.projectId,
      ]
    : [accountModelPreferences.accountId, accountModelPreferences.scope, accountModelPreferences.scopeKey];
  const targetWhere = projectId ? sql`project_id is not null` : sql`project_id is null`;
  if (params.onlyIfAbsent) {
    await db
      .insert(accountModelPreferences)
      .values({
        accountId: params.accountId,
        scope: params.scope,
        scopeKey,
        projectId,
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
      projectId,
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
  /** scope='agent' only — deletes THIS project's pin, never another project's or the legacy global one. */
  projectId?: string | null;
}): Promise<void> {
  const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
  const projectId = params.scope === 'agent' ? (params.projectId ?? null) : null;
  await db
    .delete(accountModelPreferences)
    .where(
      and(
        eq(accountModelPreferences.accountId, params.accountId),
        eq(accountModelPreferences.scope, params.scope),
        eq(accountModelPreferences.scopeKey, scopeKey),
        projectId ? eq(accountModelPreferences.projectId, projectId) : isNull(accountModelPreferences.projectId),
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
