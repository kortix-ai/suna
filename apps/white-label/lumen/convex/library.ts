// The firm library: playbooks and templates, written in Markdown by the firm.
// They are data, not agent kit: editing one needs no install. A run copies the
// body it uses into its Drive folder, so a later edit never changes a run.

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { isAdminRole, requireFirm } from "./access";
import { audit } from "./audit";
import { DEFAULT_LIBRARY } from "./kit/library.generated";
import { templateFields } from "./lib/template";
import { libraryKind } from "./schema";

const itemView = v.object({
  _id: v.id("libraryItems"), kind: libraryKind, name: v.string(), description: v.optional(v.string()), body: v.string(),
  updatedAt: v.number(), fields: v.array(v.string()), rules: v.number(),
});

export { templateFields };
/** The `## Rule <id>:` headings of a playbook. */
export const playbookRules = (body: string) => [...body.matchAll(/^##\s+Rule\s+([^:]+):/gm)].length;

/** Seed the default playbook and templates once per firm. Idempotent: a firm with any item is left alone. */
export async function seedLibrary(ctx: MutationCtx, firmId: Id<"firms">, userId: string) {
  if (await ctx.db.query("libraryItems").withIndex("by_firm_kind", (q) => q.eq("firmId", firmId)).first()) return 0;
  for (const item of DEFAULT_LIBRARY) {
    await ctx.db.insert("libraryItems", { firmId, kind: item.kind, name: item.name, body: item.body, updatedBy: userId, updatedAt: Date.now() });
  }
  return DEFAULT_LIBRARY.length;
}

export const list = query({
  args: { firmId: v.id("firms"), kind: v.optional(libraryKind) },
  returns: v.union(v.null(), v.array(itemView)),
  handler: async (ctx, { firmId, kind }) => {
    try {
      await requireFirm(ctx, firmId);
    } catch {
      return null;
    }
    const rows = await ctx.db
      .query("libraryItems")
      .withIndex("by_firm_kind", (q) => (kind ? q.eq("firmId", firmId).eq("kind", kind) : q.eq("firmId", firmId)))
      .collect();
    return rows
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .map((r) => ({
        _id: r._id, kind: r.kind, name: r.name, description: r.description, body: r.body, updatedAt: r.updatedAt,
        fields: templateFields(r.body), rules: playbookRules(r.body),
      }));
  },
});

/** Give a firm the default library when it has none (firms created before the library existed). */
export const ensureDefaults = mutation({
  args: { firmId: v.id("firms") },
  returns: v.number(),
  handler: async (ctx, { firmId }) => {
    const { userId } = await requireFirm(ctx, firmId);
    return await seedLibrary(ctx, firmId, userId);
  },
});

/** Create or edit a playbook or template. Firm items are edited by owners and admins only. */
export const save = mutation({
  args: {
    firmId: v.id("firms"), itemId: v.optional(v.id("libraryItems")), kind: libraryKind, name: v.string(), description: v.optional(v.string()),
    body: v.string(),
  },
  returns: v.id("libraryItems"),
  handler: async (ctx, a) => {
    const { firm, userId, role } = await requireFirm(ctx, a.firmId);
    if (!isAdminRole(role)) throw new Error("403: only owners and admins edit the firm library");
    const name = a.name.trim().slice(0, 120);
    const body = a.body.slice(0, 100_000);
    if (!name || body.trim().length < 10) throw new Error("400: a name and a body are required");
    if (a.kind === "playbook" && playbookRules(body) === 0) throw new Error('400: a playbook needs at least one "## Rule <id>: <title>" heading');
    const row = { name, description: a.description?.trim().slice(0, 300) || undefined, body, updatedBy: userId, updatedAt: Date.now() };
    if (a.itemId) {
      const item = await ctx.db.get(a.itemId);
      if (!item || item.firmId !== firm._id) throw new Error("404: library item not found");
      await ctx.db.patch(a.itemId, row);
      await audit(ctx, { firm, actorId: userId, action: "library.update", detail: `${item.kind}: ${name}` });
      return a.itemId;
    }
    const id = await ctx.db.insert("libraryItems", { firmId: firm._id, kind: a.kind, ...row });
    await audit(ctx, { firm, actorId: userId, action: "library.create", detail: `${a.kind}: ${name}` });
    return id;
  },
});

/** Operator (seed and eval scripts): the firm's library ids, seeding the defaults first when it has none. */
export const defaultsAsOwner = internalMutation({
  args: { firmId: v.id("firms") },
  returns: v.array(v.object({ _id: v.id("libraryItems"), kind: libraryKind, name: v.string() })),
  handler: async (ctx, { firmId }) => {
    const firm = await ctx.db.get(firmId);
    if (!firm) throw new Error("404: firm not found");
    await seedLibrary(ctx, firmId, firm.createdBy);
    const rows = await ctx.db.query("libraryItems").withIndex("by_firm_kind", (q) => q.eq("firmId", firmId)).collect();
    return rows.map((r) => ({ _id: r._id, kind: r.kind, name: r.name }));
  },
});
