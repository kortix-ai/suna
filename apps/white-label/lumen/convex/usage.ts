import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireFirmAdmin } from "./access";

const DAY = 86_400_000;

/** Admin: conversations in the last 30 days, per member and per matter. */
export const summary = query({
  args: { firmId: v.id("firms") },
  returns: v.object({
    since: v.number(),
    threads: v.number(),
    byMember: v.array(v.object({ userId: v.string(), threads: v.number() })),
    byMatter: v.array(v.object({ matterId: v.id("matters"), name: v.string(), threads: v.number() })),
    byDay: v.array(v.object({ day: v.string(), threads: v.number() })),
  }),
  handler: async (ctx, { firmId }) => {
    await requireFirmAdmin(ctx, firmId);
    const since = Date.now() - 30 * DAY;
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_firm", (q) => q.eq("firmId", firmId).gt("_creationTime", since))
      .take(5000);
    const count = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
      const m = new Map<K, number>();
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    const byMatter = [];
    for (const [matterId, threads] of count((r) => r.matterId)) {
      byMatter.push({ matterId, name: (await ctx.db.get(matterId))?.name ?? "", threads });
    }
    return {
      since,
      threads: rows.length,
      byMember: count((r) => r.createdBy).map(([userId, threads]) => ({ userId, threads })),
      byMatter,
      byDay: count((r) => new Date(r._creationTime).toISOString().slice(0, 10))
        .map(([day, threads]) => ({ day, threads }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    };
  },
});
