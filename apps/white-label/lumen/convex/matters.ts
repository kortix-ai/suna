import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalQuery, mutation, query } from "./_generated/server";
import { canSeeMatter, isAdminRole, requireFirm, requireMatterAccess } from "./access";
import { audit } from "./audit";
import { MATTERS_ROOT } from "./lumenAgent";
import { matterStatus, party, visibility } from "./schema";

const matterView = v.object({
  _id: v.id("matters"),
  _creationTime: v.number(),
  firmId: v.id("firms"),
  name: v.string(),
  number: v.optional(v.string()),
  client: v.string(),
  parties: v.array(party),
  practiceArea: v.optional(v.string()),
  status: matterStatus,
  visibility,
  createdBy: v.string(),
  updatedAt: v.number(),
  threadCount: v.number(),
  documentCount: v.number(),
  runCount: v.number(),
  lastActivityAt: v.number(),
});

async function view(ctx: QueryCtx, m: Doc<"matters">) {
  const threads = await ctx.db.query("threads").withIndex("by_matter", (q) => q.eq("matterId", m._id)).take(500);
  const docs = await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", m._id)).take(1000);
  const runs = await ctx.db.query("runs").withIndex("by_matter", (q) => q.eq("matterId", m._id)).take(1000);
  const last = Math.max(
    m.updatedAt,
    ...threads.map((t) => t.lastMessageAt),
    ...runs.map((r) => r.finishedAt ?? r._creationTime),
    ...docs.map((d) => d._creationTime),
  );
  return {
    _id: m._id, _creationTime: m._creationTime, firmId: m.firmId, name: m.name, number: m.number, client: m.client, parties: m.parties,
    practiceArea: m.practiceArea, status: m.status, visibility: m.visibility, createdBy: m.createdBy, updatedAt: m.updatedAt,
    threadCount: threads.length, documentCount: docs.length, runCount: runs.length, lastActivityAt: last,
  };
}

/** Matters the caller may see, most recently active first. `search` matches name, client or number. */
export const list = query({
  args: { firmId: v.id("firms"), status: v.optional(matterStatus), search: v.optional(v.string()) },
  returns: v.array(matterView),
  handler: async (ctx, { firmId, status, search }) => {
    const { userId, role } = await requireFirm(ctx, firmId);
    const rows = await ctx.db.query("matters").withIndex("by_firm_updatedAt", (q) => q.eq("firmId", firmId)).order("desc").take(500);
    const q = search?.trim().toLowerCase();
    const out = [];
    for (const m of rows) {
      if (status && m.status !== status) continue;
      if (q && ![m.name, m.client, m.number ?? ""].some((s) => s.toLowerCase().includes(q))) continue;
      if (!(await canSeeMatter(ctx, m, userId, role))) continue;
      out.push(await view(ctx, m));
    }
    return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  },
});

/** One matter. "forbidden" is a real 403 the page shows; "missing" covers unknown ids and other firms. */
export const get = query({
  args: { matterId: v.string() },
  returns: v.union(
    v.object({ access: v.literal("ok"), matter: matterView, members: v.array(v.string()), canManage: v.boolean() }),
    v.object({ access: v.union(v.literal("forbidden"), v.literal("missing")) }),
  ),
  handler: async (ctx, { matterId }) => {
    const id = ctx.db.normalizeId("matters", matterId);
    if (!id) return { access: "missing" as const };
    try {
      const { matter, userId, role } = await requireMatterAccess(ctx, id);
      const members = await ctx.db.query("matterMembers").withIndex("by_matter", (q) => q.eq("matterId", id)).take(200);
      return {
        access: "ok" as const,
        matter: await view(ctx, matter),
        members: members.map((m) => m.userId),
        canManage: isAdminRole(role) || matter.createdBy === userId,
      };
    } catch (err) {
      const msg = String((err as Error).message);
      if (msg.startsWith("403: no access")) return { access: "forbidden" as const };
      return { access: "missing" as const };
    }
  },
});

function cleanParties(parties: Doc<"matters">["parties"]) {
  return parties
    .map((p) => ({ name: p.name.trim().slice(0, 120), role: p.role }))
    .filter((p) => p.name)
    .slice(0, 20);
}

function cleanText(s: string | undefined, max: number) {
  const t = s?.trim().slice(0, max);
  return t ? t : undefined;
}

async function setMembers(ctx: MutationCtx, matterId: Id<"matters">, userIds: string[]) {
  const existing = await ctx.db.query("matterMembers").withIndex("by_matter", (q) => q.eq("matterId", matterId)).take(200);
  const want = new Set(userIds);
  for (const row of existing) if (!want.has(row.userId)) await ctx.db.delete(row._id);
  const have = new Set(existing.map((r) => r.userId));
  for (const u of want) if (!have.has(u)) await ctx.db.insert("matterMembers", { matterId, userId: u });
}

export const create = mutation({
  args: {
    firmId: v.id("firms"),
    name: v.string(),
    number: v.optional(v.string()),
    client: v.string(),
    parties: v.array(party),
    practiceArea: v.optional(v.string()),
    visibility,
    members: v.optional(v.array(v.string())),
  },
  returns: v.id("matters"),
  handler: async (ctx, a) => {
    const { firm, userId } = await requireFirm(ctx, a.firmId);
    const name = a.name.trim();
    if (name.length < 1 || name.length > 120) throw new Error("400: matter name must be 1-120 characters");
    const now = Date.now();
    const matterId = await ctx.db.insert("matters", {
      firmId: a.firmId, name, number: cleanText(a.number, 40), client: a.client.trim().slice(0, 120),
      parties: cleanParties(a.parties), practiceArea: cleanText(a.practiceArea, 60), status: "open", visibility: a.visibility,
      driveFolder: "", createdBy: userId, updatedAt: now,
    });
    await ctx.db.patch(matterId, { driveFolder: `${MATTERS_ROOT(a.firmId)}/${matterId}` });
    if (a.visibility === "restricted") await setMembers(ctx, matterId, [userId, ...(a.members ?? [])]);
    await audit(ctx, { firm, actorId: userId, action: "matter.create", matterId, detail: name });
    return matterId;
  },
});

export const update = mutation({
  args: {
    matterId: v.id("matters"),
    name: v.optional(v.string()),
    number: v.optional(v.string()),
    client: v.optional(v.string()),
    parties: v.optional(v.array(party)),
    practiceArea: v.optional(v.string()),
    status: v.optional(matterStatus),
    visibility: v.optional(visibility),
    members: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { matterId, ...a }) => {
    const { matter, firm, userId, role } = await requireMatterAccess(ctx, matterId);
    const manages = isAdminRole(role) || matter.createdBy === userId;
    if ((a.visibility !== undefined || a.members !== undefined) && !manages) {
      throw new Error("403: only the matter's creator or an admin changes who can see it");
    }
    const patch: Partial<Doc<"matters">> = { updatedAt: Date.now() };
    const changed: string[] = [];
    if (a.name !== undefined) {
      const name = a.name.trim();
      if (name.length < 1 || name.length > 120) throw new Error("400: matter name must be 1-120 characters");
      patch.name = name;
      changed.push("name");
    }
    if (a.number !== undefined) { patch.number = cleanText(a.number, 40); changed.push("number"); }
    if (a.client !== undefined) { patch.client = a.client.trim().slice(0, 120); changed.push("client"); }
    if (a.parties !== undefined) { patch.parties = cleanParties(a.parties); changed.push("parties"); }
    if (a.practiceArea !== undefined) { patch.practiceArea = cleanText(a.practiceArea, 60); changed.push("practice area"); }
    if (a.status !== undefined && a.status !== matter.status) { patch.status = a.status; changed.push(`status → ${a.status}`); }
    if (a.visibility !== undefined && a.visibility !== matter.visibility) { patch.visibility = a.visibility; changed.push(`visibility → ${a.visibility}`); }
    await ctx.db.patch(matterId, patch);
    if (a.members !== undefined) {
      await setMembers(ctx, matterId, [...new Set([matter.createdBy, ...a.members])]);
      changed.push("members");
    }
    if (patch.visibility === "restricted" && a.members === undefined) {
      const any = await ctx.db.query("matterMembers").withIndex("by_matter", (q) => q.eq("matterId", matterId)).first();
      if (!any) await setMembers(ctx, matterId, [matter.createdBy]);
    }
    const action = patch.status === "closed" ? "matter.close" : "matter.update";
    await audit(ctx, { firm, actorId: userId, action, matterId, detail: changed.join(", ") });
    return null;
  },
});

/** Matter + firm, for an action that works on a matter as the caller. The firm must be onboarded. */
export const access = internalQuery({
  args: { matterId: v.string() },
  returns: v.object({
    matterId: v.id("matters"),
    firmId: v.id("firms"),
    userId: v.string(),
    orgId: v.string(),
    matterName: v.string(),
    driveFolder: v.string(),
  }),
  handler: async (ctx, { matterId }) => {
    const id = ctx.db.normalizeId("matters", matterId);
    if (!id) throw new Error("404: matter not found");
    const { matter, firm, userId } = await requireMatterAccess(ctx, id);
    if (firm.status !== "ready" || !firm.kortixAgent) throw new Error("409: the firm workspace is still being set up");
    return {
      matterId: id, firmId: firm._id, userId, orgId: firm.orgId,
      matterName: matter.name, driveFolder: matter.driveFolder,
    };
  },
});
