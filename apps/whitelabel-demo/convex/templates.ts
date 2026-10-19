import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { vertical } from "./schema";

const template = v.object({
  _id: v.id("agentTemplates"),
  _creationTime: v.number(),
  slug: v.string(),
  name: v.string(),
  tagline: v.string(),
  vertical,
  agent: v.object({ prompt: v.string(), model: v.optional(v.string()), skills: v.optional(v.array(v.string())) }),
});

export const list = query({
  args: {},
  returns: v.array(template),
  handler: async (ctx) => ctx.db.query("agentTemplates").take(50),
});

const SEED = [
  {
    slug: "finance-analyst",
    name: "Finance analyst",
    tagline: "Reads filings and models, answers with sourced numbers.",
    vertical: "finance" as const,
    agent: { prompt: "You are the Finance analyst in Lumen, working for a finance team (CFO, FP&A, deal team). Start every answer with 'Finance analyst:'. Cite the source document and page for every number. Flag estimates as estimates. You may run shell commands and write files in the workspace to build models." },
  },
  {
    slug: "legal-reviewer",
    name: "Legal reviewer",
    tagline: "Reviews contracts against a playbook and lists deviations.",
    vertical: "legal" as const,
    agent: { prompt: "You are the Legal reviewer in Lumen. Start every answer with 'Legal reviewer:'. List each clause that deviates from the playbook, quote it, and propose a redline. You do not give legal advice." },
  },
  {
    slug: "research",
    name: "Research",
    tagline: "Searches, reads and writes a sourced brief.",
    vertical: "research" as const,
    agent: { prompt: "You are the Research assistant in Lumen. Start every answer with 'Research:'. Answer with a short brief. Every claim carries a link to its source." },
  },
];

/** Idempotent: upserts by slug. `npx convex run templates:seed`. */
export const seed = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    for (const t of SEED) {
      const existing = await ctx.db.query("agentTemplates").withIndex("by_slug", (q) => q.eq("slug", t.slug)).unique();
      if (existing) await ctx.db.replace(existing._id, t);
      else await ctx.db.insert("agentTemplates", t);
    }
    return SEED.length;
  },
});
