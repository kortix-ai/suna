import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Better Auth ids (user, organization) are strings: they live in the betterAuth component.

export const plan = v.union(v.literal("trial"), v.literal("solo"), v.literal("team"), v.literal("firm"));
export const billingStatus = v.union(v.literal("none"), v.literal("active"), v.literal("past_due"), v.literal("canceled"));
export const firmStatus = v.union(v.literal("provisioning"), v.literal("ready"), v.literal("failed"));
export const sizeBand = v.union(v.literal("1"), v.literal("2-10"), v.literal("11-50"), v.literal("51+"));
export const matterStatus = v.union(v.literal("open"), v.literal("on_hold"), v.literal("closed"));
export const visibility = v.union(v.literal("firm"), v.literal("restricted"));
export const partyRole = v.union(
  v.literal("client"), v.literal("counterparty"), v.literal("target"), v.literal("landlord"),
  v.literal("tenant"), v.literal("employee"), v.literal("other"),
);
export const party = v.object({ name: v.string(), role: partyRole });

export const auditAction = v.union(
  v.literal("firm.create"), v.literal("firm.ready"), v.literal("firm.failed"), v.literal("firm.update"),
  v.literal("member.invite"), v.literal("member.join"), v.literal("member.role"), v.literal("member.remove"),
  v.literal("member.invite_cancel"),
  v.literal("matter.create"), v.literal("matter.update"), v.literal("matter.close"),
  v.literal("thread.create"), v.literal("thread.delete"),
  v.literal("token.mint"),
  v.literal("billing.plan"), v.literal("billing.checkout"),
  v.literal("export.csv"),
);

export default defineSchema({
  // One Better Auth organization = one firm = one Kortix project.
  firms: defineTable({
    orgId: v.string(),
    name: v.string(),
    practiceTags: v.array(v.string()),
    sizeBand,
    jurisdiction: v.optional(v.string()),
    logoId: v.optional(v.id("_storage")),
    model: v.optional(v.string()),
    kortixProjectId: v.optional(v.string()),
    kortixDriveId: v.optional(v.string()),
    kitVersion: v.optional(v.string()),
    status: firmStatus,
    error: v.optional(v.string()),
    plan,
    seats: v.number(),
    billingStatus,
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    trialEndsAt: v.optional(v.number()),
    createdBy: v.string(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_kortixProjectId", ["kortixProjectId"])
    .index("by_stripeCustomerId", ["stripeCustomerId"]),

  matters: defineTable({
    firmId: v.id("firms"),
    name: v.string(),
    number: v.optional(v.string()),
    client: v.string(),
    parties: v.array(party),
    practiceArea: v.optional(v.string()),
    status: matterStatus,
    visibility,
    // Drive path under the firm's project Drive, written by provisioning (stage 2 uses it).
    driveFolder: v.string(),
    createdBy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_firm_updatedAt", ["firmId", "updatedAt"]),

  matterMembers: defineTable({ matterId: v.id("matters"), userId: v.string() })
    .index("by_matter", ["matterId"])
    .index("by_matter_user", ["matterId", "userId"]),

  threads: defineTable({
    firmId: v.id("firms"),
    matterId: v.id("matters"),
    kortixSessionId: v.string(),
    title: v.string(),
    createdBy: v.string(),
    lastMessageAt: v.number(),
  })
    .index("by_matter", ["matterId"])
    .index("by_firm", ["firmId"])
    .index("by_kortixSessionId", ["kortixSessionId"]),

  // Short-lived project-scoped Kortix PATs, one per (firm, member). Never returned by a public query.
  memberTokens: defineTable({
    firmId: v.id("firms"),
    userId: v.string(),
    tokenId: v.string(),
    secret: v.string(),
    expiresAt: v.number(),
  }).index("by_firm_user", ["firmId", "userId"]),

  // Immutable: no delete mutation exists.
  auditEvents: defineTable({
    firmId: v.optional(v.id("firms")),
    orgId: v.string(),
    actorId: v.string(),
    action: auditAction,
    matterId: v.optional(v.id("matters")),
    detail: v.optional(v.string()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_action", ["orgId", "action"]),

  stripeEvents: defineTable({ eventId: v.string() }).index("by_eventId", ["eventId"]),
});
