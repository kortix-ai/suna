// Lumen's one Kortix project: its state row, the single-flight claim the
// bootstrap and kit upgrade share, and each firm's service-account secret.
// The Kortix calls themselves are the node actions in convex/kortix.ts.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { KIT } from "./kit/bundle.generated";

/** A claim older than this is presumed dead and may be taken again. */
const STALE_MS = 5 * 60_000;

export async function deploymentRow(ctx: QueryCtx): Promise<Doc<"deployment"> | null> {
  return await ctx.db.query("deployment").withIndex("by_key", (q) => q.eq("key", "default")).unique();
}

const current = (d: Doc<"deployment"> | null) =>
  !!d && d.status === "ready" && d.kitVersion === KIT.version && d.kitHash === KIT.hash;

const ready = v.object({ projectId: v.string(), accountId: v.string(), driveId: v.string(), kitVersion: v.string() });

/** The deployment when it is ready with the kit this code ships, else null. */
export const state = internalQuery({
  args: {},
  returns: v.union(v.null(), ready),
  handler: async (ctx) => {
    const d = await deploymentRow(ctx);
    return current(d) ? { projectId: d!.projectId!, accountId: d!.accountId!, driveId: d!.driveId!, kitVersion: d!.kitVersion! } : null;
  },
});

/**
 * Claim the bootstrap / kit upgrade. "current": nothing to do. "busy": another
 * action holds a fresh claim. "claimed": the caller does it, starting from the
 * ids already stored (a kit upgrade reuses the project and Drive).
 */
export const claim = internalMutation({
  args: {},
  returns: v.union(
    v.object({ outcome: v.union(v.literal("current"), v.literal("busy")) }),
    v.object({
      outcome: v.literal("claimed"),
      projectId: v.optional(v.string()),
      accountId: v.optional(v.string()),
      driveId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const d = await deploymentRow(ctx);
    if (current(d)) return { outcome: "current" as const };
    if (d?.claimedAt && Date.now() - d.claimedAt < STALE_MS) return { outcome: "busy" as const };
    if (d) await ctx.db.patch(d._id, { claimedAt: Date.now() });
    else await ctx.db.insert("deployment", { key: "default", status: "provisioning", claimedAt: Date.now() });
    return { outcome: "claimed" as const, projectId: d?.projectId, accountId: d?.accountId, driveId: d?.driveId };
  },
});

/** Release the claim: the ids found so far are kept either way, so a retry resumes. */
export const settle = internalMutation({
  args: {
    projectId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    driveId: v.optional(v.string()),
    kitVersion: v.optional(v.string()),
    kitHash: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const d = await deploymentRow(ctx);
    if (!d) return null;
    if (a.error) console.error(`[lumen] deployment: ${a.error}`);
    const ids = Object.fromEntries(Object.entries({ projectId: a.projectId, accountId: a.accountId, driveId: a.driveId }).filter(([, x]) => x));
    await ctx.db.patch(d._id, {
      ...ids,
      claimedAt: undefined,
      ...(a.error
        ? { error: a.error }
        : { status: "ready" as const, kitVersion: a.kitVersion, kitHash: a.kitHash, error: undefined }),
    });
    return null;
  },
});

/** The firm's service-account secret, or null before onboarding stored it. Internal only. */
export const credential = internalQuery({
  args: { firmId: v.id("firms") },
  returns: v.union(v.null(), v.object({ serviceAccountId: v.string(), secret: v.string() })),
  handler: async (ctx, { firmId }) => {
    const row = await ctx.db.query("firmCredentials").withIndex("by_firm", (q) => q.eq("firmId", firmId)).unique();
    return row ? { serviceAccountId: row.serviceAccountId, secret: row.secret } : null;
  },
});

export const storeCredential = internalMutation({
  args: { firmId: v.id("firms"), serviceAccountId: v.string(), secret: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("firmCredentials").withIndex("by_firm", (q) => q.eq("firmId", a.firmId)).unique();
    if (row) await ctx.db.replace(row._id, a);
    else await ctx.db.insert("firmCredentials", a);
    await ctx.db.patch(a.firmId, { kortixServiceAccountId: a.serviceAccountId });
    return null;
  },
});

/** The firm's agent config was written with this kit hash and model. */
export const markAgent = internalMutation({
  args: { firmId: v.id("firms"), kortixAgent: v.string(), agentConfig: v.string() },
  returns: v.null(),
  handler: async (ctx, { firmId, kortixAgent, agentConfig }) => {
    await ctx.db.patch(firmId, { kortixAgent, agentConfig });
    return null;
  },
});

/** Everything a Kortix call for one firm needs: the shared project and Drive, the firm's agent and secret. */
export type FirmContext = {
  firmId: Id<"firms">;
  projectId: string;
  driveId: string;
  agent: string;
  secret: string;
  model?: string;
  agentConfig?: string;
};

export const firmContext = internalQuery({
  args: { firmId: v.id("firms") },
  returns: v.union(
    v.null(),
    v.object({
      firmId: v.id("firms"), projectId: v.string(), driveId: v.string(), agent: v.string(), secret: v.string(),
      model: v.optional(v.string()), agentConfig: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { firmId }): Promise<FirmContext | null> => {
    const d = await deploymentRow(ctx);
    const firm = await ctx.db.get(firmId);
    const cred = await ctx.db.query("firmCredentials").withIndex("by_firm", (q) => q.eq("firmId", firmId)).unique();
    if (!d?.projectId || !d.driveId || !firm?.kortixAgent || !cred) return null;
    return {
      firmId, projectId: d.projectId, driveId: d.driveId, agent: firm.kortixAgent, secret: cred.secret,
      model: firm.model, agentConfig: firm.agentConfig,
    };
  },
});

/** The shared project id, or null before the deployment exists. Public data for a member: one project serves every firm. */
export async function projectIdOf(ctx: QueryCtx): Promise<string | null> {
  return (await deploymentRow(ctx))?.projectId ?? null;
}

/** The shared Drive id, or null before the deployment exists. */
export async function driveIdOf(ctx: QueryCtx): Promise<string | null> {
  return (await deploymentRow(ctx))?.driveId ?? null;
}
