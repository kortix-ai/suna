// The agent kit's install state per firm. The install itself is the node
// action in convex/kitInstall.ts; this file owns the single-flight claim.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { audit } from "./audit";
import { KIT } from "./kit/bundle.generated";

/** An install older than this is presumed dead and may be claimed again. */
const STALE_MS = 5 * 60_000;

export const state = internalQuery({
  args: { firmId: v.id("firms") },
  returns: v.object({
    current: v.boolean(),
    running: v.boolean(),
    kortixProjectId: v.optional(v.string()),
    model: v.optional(v.string()),
    lastError: v.optional(v.string()),
  }),
  handler: async (ctx, { firmId }) => {
    const firm = await ctx.db.get(firmId);
    if (!firm) throw new Error("404: firm not found");
    const last = await ctx.db.query("kitInstalls").withIndex("by_firm", (q) => q.eq("firmId", firmId)).order("desc").first();
    return {
      current: firm.kitVersion === KIT.version && firm.kitHash === KIT.hash,
      running: last?.status === "running" && Date.now() - last.startedAt < STALE_MS,
      kortixProjectId: firm.kortixProjectId,
      model: firm.model,
      lastError: last?.status === "failed" ? last.error : undefined,
    };
  },
});

/** Claim the install: null when the kit is current or another install is running. */
export const claim = internalMutation({
  args: { firmId: v.id("firms") },
  returns: v.union(v.null(), v.id("kitInstalls")),
  handler: async (ctx, { firmId }) => {
    const firm = await ctx.db.get(firmId);
    if (!firm?.kortixProjectId) return null;
    if (firm.kitVersion === KIT.version && firm.kitHash === KIT.hash) return null;
    const last = await ctx.db.query("kitInstalls").withIndex("by_firm", (q) => q.eq("firmId", firmId)).order("desc").first();
    if (last?.status === "running" && Date.now() - last.startedAt < STALE_MS) return null;
    return await ctx.db.insert("kitInstalls", { firmId, version: KIT.version, hash: KIT.hash, status: "running", startedAt: Date.now() });
  },
});

export const settle = internalMutation({
  args: { installId: v.id("kitInstalls"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { installId, error }) => {
    const row = await ctx.db.get(installId);
    if (!row) return null;
    await ctx.db.patch(installId, { status: error ? "failed" : "succeeded", finishedAt: Date.now(), error });
    const firm = await ctx.db.get(row.firmId);
    if (!firm) return null;
    if (error) {
      console.error(`[lumen] kit install ${row.version} for ${row.firmId} failed: ${error}`);
      return null;
    }
    await ctx.db.patch(row.firmId, { kitVersion: row.version, kitHash: row.hash });
    await audit(ctx, { firm, actorId: "system", action: "kit.install", detail: `${row.version} (${row.hash})` });
    return null;
  },
});
