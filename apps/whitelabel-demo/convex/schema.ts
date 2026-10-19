import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Better Auth ids (user, organization) are strings: they live in the betterAuth component.
export const vertical = v.union(v.literal("finance"), v.literal("legal"), v.literal("research"));

export default defineSchema({
  agentTemplates: defineTable({
    slug: v.string(),
    name: v.string(),
    tagline: v.string(),
    vertical,
    agent: v.object({ prompt: v.string(), model: v.optional(v.string()), skills: v.optional(v.array(v.string())) }),
  }).index("by_slug", ["slug"]),

  workspaces: defineTable({
    orgId: v.string(),
    name: v.string(),
    templateSlug: v.string(),
    kortixProjectId: v.union(v.null(), v.string()),
    status: v.union(v.literal("provisioning"), v.literal("ready"), v.literal("failed")),
    error: v.optional(v.string()),
    createdBy: v.string(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_kortixProjectId", ["kortixProjectId"]),

  threads: defineTable({
    workspaceId: v.id("workspaces"),
    kortixSessionId: v.string(),
    title: v.string(),
    createdBy: v.string(),
  })
    .index("by_workspaceId", ["workspaceId"])
    .index("by_kortixSessionId", ["kortixSessionId"]),

  // Short-lived project-scoped Kortix PATs, one per (workspace, member). Never returned by a public query.
  memberTokens: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    tokenId: v.string(),
    secret: v.string(),
    expiresAt: v.number(),
  }).index("by_workspaceId_and_userId", ["workspaceId", "userId"]),

  auditEvents: defineTable({
    orgId: v.string(),
    actorId: v.string(),
    action: v.union(
      v.literal("workspace.create"),
      v.literal("workspace.ready"),
      v.literal("workspace.failed"),
      v.literal("thread.create"),
      v.literal("token.mint"),
    ),
    workspaceId: v.optional(v.id("workspaces")),
    detail: v.optional(v.string()),
  }).index("by_orgId", ["orgId"]),
});
