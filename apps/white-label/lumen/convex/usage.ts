import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireFirmAdmin } from "./access";

const DAY = 86_400_000;
const row = { threads: v.number(), runs: v.number() };

/** Admin: the last 30 days of work. Conversations, runs by kind, agent time and documents read, per member and per matter. */
export const summary = query({
  args: { firmId: v.id("firms") },
  returns: v.object({
    since: v.number(),
    threads: v.number(),
    runs: v.number(),
    agentMs: v.number(),
    documentsRead: v.number(),
    byKind: v.array(v.object({ kind: v.string(), runs: v.number() })),
    byMember: v.array(v.object({ userId: v.string(), ...row })),
    byMatter: v.array(v.object({ matterId: v.id("matters"), name: v.string(), ...row })),
  }),
  handler: async (ctx, { firmId }) => {
    await requireFirmAdmin(ctx, firmId);
    const since = Date.now() - 30 * DAY;
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_firm", (q) => q.eq("firmId", firmId).gt("_creationTime", since))
      .take(5000);
    const runs = (await ctx.db.query("runs").withIndex("by_firm_status", (q) => q.eq("firmId", firmId)).take(5000)).filter(
      (r) => r._creationTime > since,
    );
    const tally = (key: (r: { createdBy: string; matterId: string }) => string) => {
      const m = new Map<string, { threads: number; runs: number }>();
      const get = (k: string) => m.get(k) ?? m.set(k, { threads: 0, runs: 0 }).get(k)!;
      for (const t of threads) get(key(t)).threads++;
      for (const r of runs) get(key(r)).runs++;
      return [...m].sort((a, b) => b[1].threads + b[1].runs - (a[1].threads + a[1].runs));
    };
    const kinds = new Map<string, number>();
    for (const r of runs) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    const byMatter = [];
    for (const [id, c] of tally((r) => r.matterId)) {
      const matterId = id as Id<"matters">;
      byMatter.push({ matterId, name: (await ctx.db.get(matterId))?.name ?? "", ...c });
    }
    return {
      since,
      threads: threads.length,
      runs: runs.length,
      agentMs: runs.reduce((s, r) => s + (r.startedAt && r.finishedAt ? r.finishedAt - r.startedAt : 0), 0),
      documentsRead: runs.reduce((s, r) => s + r.documentIds.length, 0),
      byKind: [...kinds].map(([kind, n]) => ({ kind, runs: n })).sort((a, b) => b.runs - a.runs),
      byMember: tally((r) => r.createdBy).map(([userId, c]) => ({ userId, ...c })),
      byMatter,
    };
  },
});
