import { accountModelPreferences, projectLlmRoutingPolicies } from "@kortix/db";
import { and, eq } from "drizzle-orm";
import { db } from "../shared/db";
import type {
  ProjectRoutingFallback,
  ProjectRoutingPolicyInput,
  ProjectRoutingRule,
} from "../llm-gateway/routing/project-policy";

export interface StoredProjectRoutingPolicy {
  visionModel: string | null;
  defaultFallback: ProjectRoutingFallback | null;
  rules: ProjectRoutingRule[];
}

const TTL_MS = 30_000;
const cache = new Map<
  string,
  { value: StoredProjectRoutingPolicy | null; expiresAt: number }
>();

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
  };
}

export async function getProjectRoutingPolicy(
  projectId: string,
): Promise<StoredProjectRoutingPolicy | null> {
  const cached = cache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [row] = await db
    .select()
    .from(projectLlmRoutingPolicies)
    .where(eq(projectLlmRoutingPolicies.projectId, projectId))
    .limit(1);
  const value = row ? fromRow(row) : null;
  cache.set(projectId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidateProjectRoutingPolicy(projectId: string): void {
  cache.delete(projectId);
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
        updatedBy: params.updatedBy,
      })
      .onConflictDoUpdate({
        target: projectLlmRoutingPolicies.projectId,
        set: {
          visionModel: params.policy.visionModel,
          defaultFallbackModels: params.policy.defaultFallback?.models ?? null,
          defaultFallbackOn: params.policy.defaultFallback?.fallbackOn ?? null,
          rules: params.policy.rules,
          updatedBy: params.updatedBy,
          updatedAt: now,
        },
      });
  });
  invalidateProjectRoutingPolicy(params.projectId);
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
  invalidateProjectRoutingPolicy(params.projectId);
}
