import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { sizeBand } from "./schema";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The public demo form. No account needed; one stored request per email per hour. */
export const requestDemo = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    firm: v.string(),
    size: sizeBand,
    role: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const name = a.name.trim();
    const email = a.email.trim().toLowerCase();
    const firm = a.firm.trim();
    if (!name || name.length > 120) throw new Error("400: Enter your name.");
    if (!EMAIL.test(email) || email.length > 200) throw new Error("400: Enter a valid work email.");
    if (!firm || firm.length > 160) throw new Error("400: Enter your firm or company.");
    const message = a.message?.trim().slice(0, 2000) || undefined;
    const role = a.role?.trim().slice(0, 120) || undefined;
    const recent = await ctx.db
      .query("demoRequests")
      .withIndex("by_email", (q) => q.eq("email", email))
      .order("desc")
      .first();
    if (recent && Date.now() - recent._creationTime < 3_600_000) return { ok: true as const };
    await ctx.db.insert("demoRequests", { name, email, firm, size: a.size, role, message });
    return { ok: true as const };
  },
});
