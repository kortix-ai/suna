import { accountModelPreferences, projectSessions } from '@kortix/db';
import { Effect } from 'effect';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

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
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const rows = yield* Effect.tryPromise(() =>
      database
        .select({
          scope: accountModelPreferences.scope,
          scopeKey: accountModelPreferences.scopeKey,
          model: accountModelPreferences.model,
        })
        .from(accountModelPreferences)
        .where(eq(accountModelPreferences.accountId, accountId)),
    );

    const defaults: AccountModelDefaults = { account: null, agents: {}, projects: {} };
    for (const row of rows) {
      if (row.scope === 'account') defaults.account = row.model;
      else if (row.scope === 'agent' && row.scopeKey) defaults.agents[row.scopeKey] = row.model;
      else if (row.scope === 'project' && row.scopeKey) defaults.projects[row.scopeKey] = row.model;
    }
    return defaults;
  }));
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
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const now = new Date();
    const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
    if (params.onlyIfAbsent) {
      yield* Effect.tryPromise(() =>
        database
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
          }),
      );
      return;
    }
    yield* Effect.tryPromise(() =>
      database
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
        }),
    );
  }));
}

export async function deleteAccountModelPreference(params: {
  accountId: string;
  scope: ModelPreferenceScope;
  scopeKey?: string;
}): Promise<void> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const scopeKey = preferenceScopeKey(params.scope, params.scopeKey);
    yield* Effect.tryPromise(() =>
      database
        .delete(accountModelPreferences)
        .where(
          and(
            eq(accountModelPreferences.accountId, params.accountId),
            eq(accountModelPreferences.scope, params.scope),
            eq(accountModelPreferences.scopeKey, scopeKey),
          ),
        ),
    );
  }));
}

/**
 * The agent + per-session model a gateway principal's session is bound to.
 * `principal.sessionId === sandbox_id === project_sessions.session_id` (the PK)
 * by construction, so we look up the row by that key.
 */
export async function getSessionAgentContext(
  sessionId: string,
): Promise<{ agentName: string; opencodeModel: string | null } | null> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select({ agentName: projectSessions.agentName, metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1),
    );
    if (!row) return null;
    const metadata = row.metadata as Record<string, unknown> | null;
    const opencodeModel =
      metadata && typeof metadata.opencode_model === 'string' ? metadata.opencode_model : null;
    return { agentName: row.agentName, opencodeModel };
  }));
}
