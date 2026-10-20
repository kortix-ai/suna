import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type QueryCtx, action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { isAdminRole, requireFirm, requireFirmAdmin, requireMember } from "./access";
import { audit } from "./audit";
import { stripeConfigured, trialSeats } from "./billing";
import { firmStatus, plan, sizeBand } from "./schema";

const TRIAL_DAYS = 14;

/** A firm as members see it. Kortix ids and Stripe ids stay on the server. */
const firmView = v.object({
  _id: v.id("firms"),
  _creationTime: v.number(),
  orgId: v.string(),
  name: v.string(),
  practiceTags: v.array(v.string()),
  sizeBand,
  jurisdiction: v.optional(v.string()),
  logoUrl: v.union(v.null(), v.string()),
  model: v.optional(v.string()),
  kitVersion: v.optional(v.string()),
  status: firmStatus,
  error: v.optional(v.string()),
  plan,
  seats: v.number(),
  role: v.string(),
});

async function view(ctx: QueryCtx, f: Doc<"firms">, role: string) {
  return {
    _id: f._id, _creationTime: f._creationTime, orgId: f.orgId, name: f.name, practiceTags: f.practiceTags, sizeBand: f.sizeBand,
    jurisdiction: f.jurisdiction, logoUrl: f.logoId ? await ctx.storage.getUrl(f.logoId) : null, model: f.model,
    kitVersion: f.kitVersion, status: f.status, error: f.error, plan: f.plan, seats: f.seats, role,
  };
}

const cleanTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12).map((t) => t.slice(0, 40));

/** The firm of a Better Auth organization, or null (no firm row yet, or not a member). */
export const forOrg = query({
  args: { orgId: v.string() },
  returns: v.union(v.null(), firmView),
  handler: async (ctx, { orgId }) => {
    const firm = await ctx.db.query("firms").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
    if (!firm) return null;
    try {
      const { role } = await requireMember(ctx, orgId);
      return await view(ctx, firm, role);
    } catch {
      return null;
    }
  },
});

/**
 * Onboarding step 1: the organization exists (Better Auth); this creates its
 * firm and starts provisioning. Only the organization's owner may. Idempotent per org.
 */
export const create = mutation({
  args: { orgId: v.string(), name: v.string(), practiceTags: v.array(v.string()), sizeBand },
  returns: v.id("firms"),
  handler: async (ctx, args) => {
    const { userId, role } = await requireMember(ctx, args.orgId);
    if (role !== "owner") throw new Error("403: only the owner sets up the firm");
    const existing = await ctx.db.query("firms").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).unique();
    if (existing) return existing._id;
    const name = args.name.trim();
    if (name.length < 2 || name.length > 80) throw new Error("400: firm name must be 2-80 characters");
    const firmId = await ctx.db.insert("firms", {
      orgId: args.orgId, name, practiceTags: cleanTags(args.practiceTags), sizeBand: args.sizeBand,
      status: "provisioning", plan: "trial", seats: trialSeats(), billingStatus: "none",
      ...(stripeConfigured() ? { trialEndsAt: Date.now() + TRIAL_DAYS * 86_400_000 } : {}),
      createdBy: userId,
    });
    await audit(ctx, { firm: { _id: firmId, orgId: args.orgId }, actorId: userId, action: "firm.create", detail: name });
    await ctx.scheduler.runAfter(0, internal.kortix.provisionFirm, { firmId });
    return firmId;
  },
});

/** Admin: firm profile. */
export const update = mutation({
  args: {
    firmId: v.id("firms"),
    name: v.optional(v.string()),
    practiceTags: v.optional(v.array(v.string())),
    sizeBand: v.optional(sizeBand),
    jurisdiction: v.optional(v.string()),
    logoId: v.optional(v.union(v.null(), v.id("_storage"))),
  },
  returns: v.null(),
  handler: async (ctx, { firmId, ...a }) => {
    const { firm, userId } = await requireFirmAdmin(ctx, firmId);
    const patch: Partial<Doc<"firms">> = {};
    if (a.name !== undefined) {
      const name = a.name.trim();
      if (name.length < 2 || name.length > 80) throw new Error("400: firm name must be 2-80 characters");
      patch.name = name;
    }
    if (a.practiceTags) patch.practiceTags = cleanTags(a.practiceTags);
    if (a.sizeBand) patch.sizeBand = a.sizeBand;
    if (a.jurisdiction !== undefined) patch.jurisdiction = a.jurisdiction.trim().slice(0, 80) || undefined;
    if (a.logoId !== undefined) {
      if (firm.logoId && firm.logoId !== a.logoId) await ctx.storage.delete(firm.logoId);
      patch.logoId = a.logoId ?? undefined;
    }
    await ctx.db.patch(firmId, patch);
    await audit(ctx, { firm, actorId: userId, action: "firm.update", detail: Object.keys(patch).join(", ") });
    return null;
  },
});

const LOGO_MAX_BYTES = 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];

export const checkAdmin = internalQuery({
  args: { firmId: v.id("firms") },
  returns: v.null(),
  handler: async (ctx, { firmId }) => {
    await requireFirmAdmin(ctx, firmId);
    return null;
  },
});

/** Admin: store a logo (≤ 1 MiB, PNG/JPEG/SVG/WebP) in Convex storage and set it on the firm. */
export const setLogo = action({
  args: { firmId: v.id("firms"), bytes: v.bytes(), contentType: v.string() },
  returns: v.null(),
  handler: async (ctx, { firmId, bytes, contentType }) => {
    await ctx.runQuery(internal.firms.checkAdmin, { firmId });
    if (!LOGO_TYPES.includes(contentType) || bytes.byteLength > LOGO_MAX_BYTES) {
      throw new Error("400: use a PNG, JPEG, SVG or WebP image up to 1 MB");
    }
    const logoId = await ctx.storage.store(new Blob([bytes], { type: contentType }));
    await ctx.runMutation(api.firms.update, { firmId, logoId });
    return null;
  },
});

/** A failed provision runs again. The idempotency key (the firm id) keeps it to one Kortix project. */
export const retry = mutation({
  args: { firmId: v.id("firms") },
  returns: v.null(),
  handler: async (ctx, { firmId }) => {
    const { firm, role } = await requireFirm(ctx, firmId);
    if (!isAdminRole(role) || firm.status !== "failed") return null;
    await ctx.db.patch(firmId, { status: "provisioning", error: undefined });
    await ctx.scheduler.runAfter(0, internal.kortix.provisionFirm, { firmId });
    return null;
  },
});

// ── internal: read and written by the Kortix actions ──

export const forProvision = internalQuery({
  args: { firmId: v.id("firms") },
  returns: v.union(v.null(), v.object({ status: firmStatus, name: v.string(), model: v.optional(v.string()) })),
  handler: async (ctx, { firmId }) => {
    const f = await ctx.db.get(firmId);
    return f ? { status: f.status, name: f.name, model: f.model } : null;
  },
});

const SETUP_FAILED = "Setup failed. Try again.";

export const settle = internalMutation({
  args: {
    firmId: v.id("firms"),
    kortixProjectId: v.optional(v.string()),
    kortixDriveId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { firmId, kortixProjectId, kortixDriveId, error }) => {
    const firm = await ctx.db.get(firmId);
    if (!firm) return null;
    // `error` is the raw upstream cause: it goes to the Convex log only, never to a
    // member-visible row (it can name the platform). Members read the generic text.
    if (error) console.error(`[lumen] provision ${firmId} failed: ${error}`);
    await ctx.db.patch(firmId, error ? { status: "failed", error: SETUP_FAILED } : { status: "ready", kortixProjectId, kortixDriveId });
    await audit(ctx, { firm, actorId: "system", action: error ? "firm.failed" : "firm.ready" });
    return null;
  },
});
