import { accountModelPreferences, projectLlmRoutingPolicies } from "@kortix/db";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../shared/db";
import type {
  ProjectModelGenerationConfig,
  ProjectRoutingFallback,
  ProjectRoutingPolicyInput,
  ProjectRoutingRule,
} from "../llm-gateway/routing/project-policy";

export interface StoredProjectRoutingPolicy {
  visionModel: string | null;
  defaultFallback: ProjectRoutingFallback | null;
  rules: ProjectRoutingRule[];
  modelGenerationConfig: ProjectModelGenerationConfig;
}

function fromRow(
  row: typeof projectLlmRoutingPolicies.$inferSelect,
): StoredProjectRoutingPolicy {
  return {
    visionModel: row.visionModel,
    defaultFallback:
      row.defaultFallbackModels === null
        ? null
        : {
            models: row.defaultFallbackModels,
            fallbackOn: row.defaultFallbackOn as "transient" | "any-error",
          },
    rules: row.rules,
    modelGenerationConfig: (row.modelGenerationConfig ?? {}) as ProjectModelGenerationConfig,
  };
}

export async function getProjectRoutingPolicy(
  projectId: string,
): Promise<StoredProjectRoutingPolicy | null> {
  // Do not process-cache this document. API replicas cannot invalidate each
  // other's memory, so an immediate read after a write can otherwise return a
  // stale policy from whichever pod served an earlier request.
  const [row] = await db
    .select()
    .from(projectLlmRoutingPolicies)
    .where(eq(projectLlmRoutingPolicies.projectId, projectId))
    .limit(1);
  return row ? fromRow(row) : null;
}

/** Persist the complete project document and its default model atomically. */
export async function setProjectRoutingPolicy(params: {
  projectId: string;
  accountId: string;
  updatedBy: string;
  policy: ProjectRoutingPolicyInput;
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const preferenceWhere = and(
      eq(accountModelPreferences.accountId, params.accountId),
      eq(accountModelPreferences.scope, "project"),
      eq(accountModelPreferences.scopeKey, params.projectId),
    );
    if (params.policy.defaultModel) {
      await tx
        .insert(accountModelPreferences)
        .values({
          accountId: params.accountId,
          scope: "project",
          scopeKey: params.projectId,
          model: params.policy.defaultModel,
          updatedBy: params.updatedBy,
        })
        .onConflictDoUpdate({
          target: [
            accountModelPreferences.accountId,
            accountModelPreferences.scope,
            accountModelPreferences.scopeKey,
          ],
          // project-scope default is a project_id-IS-NULL row, so the ON CONFLICT
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
        projectId: params.projectId,
        visionModel: params.policy.visionModel,
        defaultFallbackModels: params.policy.defaultFallback?.models ?? null,
        defaultFallbackOn: params.policy.defaultFallback?.fallbackOn ?? null,
        rules: params.policy.rules,
        modelGenerationConfig: params.policy.modelGenerationConfig,
        updatedBy: params.updatedBy,
      })
      .onConflictDoUpdate({
        target: projectLlmRoutingPolicies.projectId,
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

export async function resetProjectRoutingPolicy(params: {
  projectId: string;
  accountId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectLlmRoutingPolicies)
      .where(eq(projectLlmRoutingPolicies.projectId, params.projectId));
    await tx
      .delete(accountModelPreferences)
      .where(
        and(
          eq(accountModelPreferences.accountId, params.accountId),
          eq(accountModelPreferences.scope, "project"),
          eq(accountModelPreferences.scopeKey, params.projectId),
        ),
      );
  });
}
