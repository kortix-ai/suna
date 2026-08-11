import { accountModelPreferences, projectLlmRoutingPolicies } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import type {
  WorkspaceModelGenerationConfig,
  WorkspaceRoutingFallback,
  WorkspaceRoutingPolicyInput,
  WorkspaceRoutingRule,
} from '../llm-gateway/routing/workspace-policy';
import { db } from '../shared/db';

export interface StoredWorkspaceRoutingPolicy {
  visionModel: string | null;
  defaultFallback: WorkspaceRoutingFallback | null;
  rules: WorkspaceRoutingRule[];
  modelGenerationConfig: WorkspaceModelGenerationConfig;
  /**
   * Exceptions to the default model set: `wireModelId -> enabled`. Resolve it
   * through `llm-gateway/model-enablement.ts` (which layers it over the catalog
   * default); never read this field as if it were the answer on its own.
   */
  modelOverrides: Record<string, boolean>;
}

function fromRow(row: typeof projectLlmRoutingPolicies.$inferSelect): StoredWorkspaceRoutingPolicy {
  return {
    visionModel: row.visionModel,
    defaultFallback:
      row.defaultFallbackModels === null
        ? null
        : {
            models: row.defaultFallbackModels,
            fallbackOn: row.defaultFallbackOn as 'transient' | 'any-error',
          },
    rules: row.rules,
    modelGenerationConfig: (row.modelGenerationConfig ?? {}) as WorkspaceModelGenerationConfig,
    modelOverrides: (row.modelOverrides ?? {}) as Record<string, boolean>,
  };
}

/**
 * Persist only the workspace's model overrides while preserving its routing policy.
 * Upserts the policy row (other fields keep their column defaults on insert and
 * are untouched on conflict), so model enablement is independent of the routing
 * editor. An empty object clears every exception, restoring the catalog default.
 */
export async function setWorkspaceModelOverrides(params: {
  workspaceId: string;
  updatedBy: string;
  modelOverrides: Record<string, boolean>;
}): Promise<void> {
  await db
    .insert(projectLlmRoutingPolicies)
    .values({
      workspaceId: params.workspaceId,
      modelOverrides: params.modelOverrides,
      updatedBy: params.updatedBy,
    })
    .onConflictDoUpdate({
      target: projectLlmRoutingPolicies.workspaceId,
      set: {
        modelOverrides: params.modelOverrides,
        updatedBy: params.updatedBy,
        updatedAt: new Date(),
      },
    });
}

export async function getWorkspaceRoutingPolicy(
  workspaceId: string,
): Promise<StoredWorkspaceRoutingPolicy | null> {
  // Do not process-cache this document. API replicas cannot invalidate each
  // other's memory, so an immediate read after a write can otherwise return a
  // stale policy from whichever pod served an earlier request.
  const [row] = await db
    .select()
    .from(projectLlmRoutingPolicies)
    .where(eq(projectLlmRoutingPolicies.workspaceId, workspaceId))
    .limit(1);
  return row ? fromRow(row) : null;
}

/** Persist the complete workspace document and its default model atomically. */
export async function setWorkspaceRoutingPolicy(params: {
  workspaceId: string;
  accountId: string;
  updatedBy: string;
  policy: WorkspaceRoutingPolicyInput;
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const preferenceWhere = and(
      eq(accountModelPreferences.accountId, params.accountId),
      eq(accountModelPreferences.scope, 'project'),
      eq(accountModelPreferences.scopeKey, params.workspaceId),
    );
    if (params.policy.defaultModel) {
      await tx
        .insert(accountModelPreferences)
        .values({
          accountId: params.accountId,
          scope: 'project',
          scopeKey: params.workspaceId,
          model: params.policy.defaultModel,
          updatedBy: params.updatedBy,
        })
        .onConflictDoUpdate({
          target: [
            accountModelPreferences.accountId,
            accountModelPreferences.scope,
            accountModelPreferences.scopeKey,
          ],
          // The stable persisted project scope uses a project_id-IS-NULL row. The ON CONFLICT
          // arbiter must name the GLOBAL partial unique index's predicate (PR #4978
          // split the old single unique index into two partial indexes). Without
          // this, Postgres errors "no unique/exclusion constraint matching ON
          // CONFLICT" and the routing-policy PUT 500s whenever defaultModel is set.
          targetWhere: sql`project_id is null`,
          set: {
            model: params.policy.defaultModel,
            updatedBy: params.updatedBy,
            updatedAt: now,
          },
        });
    } else {
      await tx.delete(accountModelPreferences).where(preferenceWhere);
    }

    await tx
      .insert(projectLlmRoutingPolicies)
      .values({
        workspaceId: params.workspaceId,
        visionModel: params.policy.visionModel,
        defaultFallbackModels: params.policy.defaultFallback?.models ?? null,
        defaultFallbackOn: params.policy.defaultFallback?.fallbackOn ?? null,
        rules: params.policy.rules,
        modelGenerationConfig: params.policy.modelGenerationConfig,
        updatedBy: params.updatedBy,
      })
      .onConflictDoUpdate({
        target: projectLlmRoutingPolicies.workspaceId,
        set: {
          visionModel: params.policy.visionModel,
          defaultFallbackModels: params.policy.defaultFallback?.models ?? null,
          defaultFallbackOn: params.policy.defaultFallback?.fallbackOn ?? null,
          rules: params.policy.rules,
          modelGenerationConfig: params.policy.modelGenerationConfig,
          updatedBy: params.updatedBy,
          updatedAt: now,
        },
      });
  });
}

export async function resetWorkspaceRoutingPolicy(params: {
  workspaceId: string;
  accountId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectLlmRoutingPolicies)
      .where(eq(projectLlmRoutingPolicies.workspaceId, params.workspaceId));
    await tx
      .delete(accountModelPreferences)
      .where(
        and(
          eq(accountModelPreferences.accountId, params.accountId),
          eq(accountModelPreferences.scope, 'project'),
          eq(accountModelPreferences.scopeKey, params.workspaceId),
        ),
      );
  });
}
