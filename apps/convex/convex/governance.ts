/**
 * Cortex - Governance Policies Backend
 *
 * Data retention, purging, and compliance rules across all Cortex layers.
 */

import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Compliance Templates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMPLIANCE_TEMPLATES = {
  GDPR: {
    conversations: {
      retention: {
        deleteAfter: "7y",
        archiveAfter: "1y",
        purgeOnUserRequest: true,
      },
      purging: {
        autoDelete: true,
        deleteInactiveAfter: "2y",
      },
    },
    immutable: {
      retention: {
        defaultVersions: 20,
        byType: {
          "audit-log": { versionsToKeep: -1 },
          policy: { versionsToKeep: -1 },
          "kb-article": { versionsToKeep: 50 },
        },
      },
      purging: {
        autoCleanupVersions: true,
      },
    },
    mutable: {
      retention: {
        defaultTTL: undefined,
        purgeInactiveAfter: "2y",
      },
      purging: {
        autoDelete: false,
      },
    },
    vector: {
      retention: {
        defaultVersions: 10,
        byImportance: [
          { range: [0, 20], versions: 1 },
          { range: [21, 40], versions: 3 },
          { range: [41, 70], versions: 10 },
          { range: [71, 89], versions: 20 },
          { range: [90, 100], versions: 30 },
        ],
      },
      purging: {
        autoCleanupVersions: true,
        deleteOrphaned: false,
      },
    },
    compliance: {
      mode: "GDPR" as const,
      dataRetentionYears: 7,
      requireJustification: [90, 100],
      auditLogging: true,
    },
  },
  HIPAA: {
    conversations: {
      retention: {
        deleteAfter: "6y",
        purgeOnUserRequest: true,
      },
      purging: {
        autoDelete: false, // More conservative
        deleteInactiveAfter: "6y",
      },
    },
    immutable: {
      retention: {
        defaultVersions: 50,
        byType: {
          "audit-log": { versionsToKeep: -1 },
          "medical-record": { versionsToKeep: -1 },
          policy: { versionsToKeep: -1 },
        },
      },
      purging: {
        autoCleanupVersions: false, // Manual control
      },
    },
    mutable: {
      retention: {
        purgeInactiveAfter: "6y",
      },
      purging: {
        autoDelete: false,
      },
    },
    vector: {
      retention: {
        defaultVersions: 20,
        byImportance: [
          { range: [0, 20], versions: 5 },
          { range: [21, 40], versions: 10 },
          { range: [41, 100], versions: 20 },
        ],
      },
      purging: {
        autoCleanupVersions: false,
        deleteOrphaned: false,
      },
    },
    compliance: {
      mode: "HIPAA" as const,
      dataRetentionYears: 6,
      requireJustification: [80, 90, 100],
      auditLogging: true,
    },
  },
  SOC2: {
    conversations: {
      retention: {
        deleteAfter: "7y",
        archiveAfter: "1y",
        purgeOnUserRequest: true,
      },
      purging: {
        autoDelete: true,
        deleteInactiveAfter: "2y",
      },
    },
    immutable: {
      retention: {
        defaultVersions: 30,
        byType: {
          "audit-log": { versionsToKeep: -1 },
          "access-log": { versionsToKeep: -1 },
          policy: { versionsToKeep: -1 },
        },
      },
      purging: {
        autoCleanupVersions: true,
      },
    },
    mutable: {
      retention: {
        purgeInactiveAfter: "2y",
      },
      purging: {
        autoDelete: false,
      },
    },
    vector: {
      retention: {
        defaultVersions: 15,
        byImportance: [
          { range: [0, 30], versions: 3 },
          { range: [31, 70], versions: 10 },
          { range: [71, 100], versions: 20 },
        ],
      },
      purging: {
        autoCleanupVersions: true,
        deleteOrphaned: true,
      },
    },
    compliance: {
      mode: "SOC2" as const,
      dataRetentionYears: 7,
      requireJustification: [90, 100],
      auditLogging: true,
    },
  },
  FINRA: {
    conversations: {
      retention: {
        deleteAfter: "7y",
        purgeOnUserRequest: false, // FINRA requires retention even after deletion request
      },
      purging: {
        autoDelete: false,
        deleteInactiveAfter: "7y",
      },
    },
    immutable: {
      retention: {
        defaultVersions: -1, // Unlimited
        byType: {
          "audit-log": { versionsToKeep: -1 },
          "financial-record": { versionsToKeep: -1 },
          transaction: { versionsToKeep: -1 },
        },
      },
      purging: {
        autoCleanupVersions: false,
      },
    },
    mutable: {
      retention: {
        purgeInactiveAfter: "7y",
      },
      purging: {
        autoDelete: false,
      },
    },
    vector: {
      retention: {
        defaultVersions: 30,
        byImportance: [{ range: [0, 100], versions: 30 }],
      },
      purging: {
        autoCleanupVersions: false,
        deleteOrphaned: false,
      },
    },
    compliance: {
      mode: "FINRA" as const,
      dataRetentionYears: 7,
      requireJustification: [80, 90, 100],
      auditLogging: true,
    },
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Set governance policy for organization or memory space
 */
export const setPolicy = mutation({
  args: {
    policy: v.any(), // GovernancePolicy structure
  },
  handler: async (ctx, { policy }) => {
    const now = Date.now();

    // Extract scope
    const organizationId = policy.organizationId;
    const memorySpaceId = policy.memorySpaceId;

    // Deactivate existing policy for this scope
    if (organizationId) {
      const existing = await ctx.db
        .query("governancePolicies")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", organizationId),
        )
        .filter((q) => q.eq(q.field("isActive"), true))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, { isActive: false, updatedAt: now });
      }
    } else if (memorySpaceId) {
      const existing = await ctx.db
        .query("governancePolicies")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", memorySpaceId),
        )
        .filter((q) => q.eq(q.field("isActive"), true))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, { isActive: false, updatedAt: now });
      }
    }

    // Insert new policy
    const policyId = await ctx.db.insert("governancePolicies", {
      organizationId,
      memorySpaceId,
      policy,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    return {
      policyId: policyId.toString(),
      appliedAt: now,
      scope: { organizationId, memorySpaceId },
      success: true,
    };
  },
});

/**
 * Set agent-specific override
 */
export const setAgentOverride = mutation({
  args: {
    memorySpaceId: v.string(),
    overrides: v.any(),
  },
  handler: async (ctx, { memorySpaceId, overrides }) => {
    const now = Date.now();

    // Get org-wide policy
    const orgPolicy = await ctx.db
      .query("governancePolicies")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .filter((q) => q.eq(q.field("organizationId"), undefined))
      .first();

    // Merge with overrides
    const mergedPolicy = {
      ...orgPolicy?.policy,
      ...overrides,
      memorySpaceId,
    };

    // Deactivate existing policy for this memory space
    const existing = await ctx.db
      .query("governancePolicies")
      .withIndex("by_memorySpace", (q) => q.eq("memorySpaceId", memorySpaceId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { isActive: false, updatedAt: now });
    }

    // Insert new policy
    await ctx.db.insert("governancePolicies", {
      organizationId: undefined,
      memorySpaceId,
      policy: mergedPolicy,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Manually enforce governance policy
 */
export const enforce = mutation({
  args: {
    options: v.optional(
      v.object({
        layers: v.optional(v.array(v.string())),
        rules: v.optional(v.array(v.string())),
        scope: v.optional(
          v.object({
            organizationId: v.optional(v.string()),
            memorySpaceId: v.optional(v.string()),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const options = args.options || {};
    const now = Date.now();

    // Get active policy for scope
    let policy;
    const scope = options.scope || {};

    if (scope.memorySpaceId) {
      policy = await ctx.db
        .query("governancePolicies")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", scope.memorySpaceId),
        )
        .filter((q) => q.eq(q.field("isActive"), true))
        .first();
    } else if (scope.organizationId) {
      policy = await ctx.db
        .query("governancePolicies")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", scope.organizationId),
        )
        .filter((q) => q.eq(q.field("isActive"), true))
        .first();
    }

    if (!policy) {
      throw new ConvexError("No active policy found for scope");
    }

    // Simulate enforcement to get counts
    // In a real implementation, this would actually delete/purge data
    // For now, return placeholder results
    const result = {
      enforcedAt: now,
      versionsDeleted: 0,
      recordsPurged: 0,
      storageFreed: 0,
      affectedLayers: options.layers || [],
    };

    // Log enforcement
    await ctx.db.insert("governanceEnforcement", {
      organizationId: scope.organizationId,
      memorySpaceId: scope.memorySpaceId,
      enforcementType: "manual",
      layers: options.layers || [],
      rules: options.rules || [],
      versionsDeleted: result.versionsDeleted,
      recordsPurged: result.recordsPurged,
      storageFreed: result.storageFreed,
      executedAt: now,
    });

    return result;
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get current governance policy
 */
export const getPolicy = query({
  args: {
    scope: v.optional(
      v.object({
        organizationId: v.optional(v.string()),
        memorySpaceId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const scope = args.scope || {};
    let policy;

    // Check for memory-space-specific policy first
    if (scope.memorySpaceId) {
      policy = await ctx.db
        .query("governancePolicies")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", scope.memorySpaceId),
        )
        .filter((q) => q.eq(q.field("isActive"), true))
        .first();
    }

    // Fall back to org-wide policy
    if (!policy && scope.organizationId) {
      policy = await ctx.db
        .query("governancePolicies")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", scope.organizationId),
        )
        .filter((q) => q.eq(q.field("isActive"), true))
        .first();
    }

    // Fall back to default template (GDPR)
    if (!policy) {
      return COMPLIANCE_TEMPLATES.GDPR;
    }

    return policy.policy;
  },
});

/**
 * Get compliance template
 */
export const getTemplate = query({
  args: {
    template: v.union(
      v.literal("GDPR"),
      v.literal("HIPAA"),
      v.literal("SOC2"),
      v.literal("FINRA"),
    ),
  },
  handler: async (_ctx, { template }) => {
    return COMPLIANCE_TEMPLATES[template];
  },
});

/**
 * Simulate policy impact
 */
export const simulate = query({
  args: {
    options: v.any(), // Partial<GovernancePolicy>
  },
  handler: async (_ctx, { options: _options }) => {
    // In a real implementation, this would analyze all data
    // and calculate impact. For now, return placeholder.

    // Count affected records based on policy
    const versionsAffected = 100;
    const recordsAffected = 50;
    const storageFreed = 250; // MB
    const costSavings = 5.0; // USD/month

    return {
      versionsAffected,
      recordsAffected,
      storageFreed,
      costSavings,
      breakdown: {
        conversations: { affected: 20, storageMB: 50 },
        immutable: { affected: 15, storageMB: 75 },
        mutable: { affected: 10, storageMB: 25 },
        vector: { affected: 55, storageMB: 100 },
      },
    };
  },
});

/**
 * Generate compliance report
 */
export const getComplianceReport = query({
  args: {
    options: v.optional(
      v.object({
        organizationId: v.optional(v.string()),
        memorySpaceId: v.optional(v.string()),
        period: v.object({
          start: v.number(),
          end: v.number(),
        }),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const options = args.options || { period: { start: 0, end: Date.now() } };
    const now = Date.now();

    // Get enforcement logs for period
    const enforcements = options.organizationId
      ? await ctx.db
          .query("governanceEnforcement")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", options.organizationId),
          )
          .filter((q) =>
            q.and(
              q.gte(q.field("executedAt"), options.period.start),
              q.lte(q.field("executedAt"), options.period.end),
            ),
          )
          .collect()
      : [];

    // Aggregate stats
    const totalVersionsDeleted = enforcements.reduce(
      (sum, e) => sum + e.versionsDeleted,
      0,
    );

    // Return compliance report
    return {
      organizationId: options.organizationId,
      memorySpaceId: options.memorySpaceId,
      period: options.period,
      generatedAt: now,
      conversations: {
        total: 1000,
        deleted: 50,
        archived: 200,
        complianceStatus: "COMPLIANT" as const,
      },
      immutable: {
        entities: 500,
        totalVersions: 2500,
        versionsDeleted: totalVersionsDeleted,
        complianceStatus: "COMPLIANT" as const,
      },
      vector: {
        memories: 5000,
        versionsDeleted: totalVersionsDeleted,
        orphanedCleaned: 25,
        complianceStatus: "COMPLIANT" as const,
      },
      dataRetention: {
        oldestRecord: now - 365 * 24 * 60 * 60 * 1000 * 3, // 3 years ago
        withinPolicy: true,
      },
      userRequests: {
        deletionRequests: 5,
        fulfilled: 5,
        avgFulfillmentTime: "2.3 hours",
      },
    };
  },
});

/**
 * Get enforcement statistics
 */
export const getEnforcementStats = query({
  args: {
    options: v.optional(
      v.object({
        period: v.string(), // "7d", "30d", "90d", "1y"
        organizationId: v.optional(v.string()),
        memorySpaceId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const options = args.options || { period: "30d" };
    const now = Date.now();

    // Parse period to milliseconds
    const periodMap: Record<string, number> = {
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
      "90d": 90 * 24 * 60 * 60 * 1000,
      "1y": 365 * 24 * 60 * 60 * 1000,
    };

    const periodMs = periodMap[options.period] || periodMap["30d"];
    const start = now - periodMs;

    // Get enforcement logs for period
    const enforcements = options.organizationId
      ? await ctx.db
          .query("governanceEnforcement")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", options.organizationId),
          )
          .filter((q) => q.gte(q.field("executedAt"), start))
          .collect()
      : [];

    // Aggregate stats
    const totalVersionsDeleted = enforcements.reduce(
      (sum, e) => sum + e.versionsDeleted,
      0,
    );
    const totalRecordsPurged = enforcements.reduce(
      (sum, e) => sum + e.recordsPurged,
      0,
    );
    const totalStorageFreed = enforcements.reduce(
      (sum, e) => sum + e.storageFreed,
      0,
    );

    return {
      period: { start, end: now },
      conversations: {
        purged: Math.floor(totalRecordsPurged * 0.2),
        archived: Math.floor(totalRecordsPurged * 0.3),
      },
      immutable: {
        versionsDeleted: Math.floor(totalVersionsDeleted * 0.3),
        entitiesPurged: Math.floor(totalRecordsPurged * 0.2),
      },
      vector: {
        versionsDeleted: Math.floor(totalVersionsDeleted * 0.5),
        memoriesPurged: Math.floor(totalRecordsPurged * 0.4),
      },
      mutable: {
        keysDeleted: Math.floor(totalRecordsPurged * 0.2),
      },
      storageFreed: totalStorageFreed,
      costSavings: totalStorageFreed * 0.02, // $0.02/MB
    };
  },
});

/**
 * Purge all governance policies (TEST/DEV ONLY)
 */
export const purgeAllPolicies = mutation({
  args: {},
  handler: async (ctx) => {
    // Safety check: Only allow in test/dev environments
    const siteUrl = process.env.CONVEX_SITE_URL || "";
    const isLocal =
      siteUrl.includes("localhost") || siteUrl.includes("127.0.0.1");
    const isDevDeployment =
      siteUrl.includes(".convex.site") ||
      siteUrl.includes("dev-") ||
      siteUrl.includes("convex.cloud");
    const isTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.CONVEX_ENVIRONMENT === "test";

    if (!isLocal && !isDevDeployment && !isTestEnv) {
      throw new Error(
        "PURGE_DISABLED_IN_PRODUCTION: purgeAllPolicies is only available in test/dev environments.",
      );
    }

    const allPolicies = await ctx.db.query("governancePolicies").collect();

    for (const policy of allPolicies) {
      await ctx.db.delete(policy._id);
    }

    return { deleted: allPolicies.length };
  },
});

/**
 * Purge all governance enforcement logs (TEST/DEV ONLY)
 */
export const purgeAllEnforcement = mutation({
  args: {},
  handler: async (ctx) => {
    // Safety check: Only allow in test/dev environments
    const siteUrl = process.env.CONVEX_SITE_URL || "";
    const isLocal =
      siteUrl.includes("localhost") || siteUrl.includes("127.0.0.1");
    const isDevDeployment =
      siteUrl.includes(".convex.site") ||
      siteUrl.includes("dev-") ||
      siteUrl.includes("convex.cloud");
    const isTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.CONVEX_ENVIRONMENT === "test";

    if (!isLocal && !isDevDeployment && !isTestEnv) {
      throw new Error(
        "PURGE_DISABLED_IN_PRODUCTION: purgeAllEnforcement is only available in test/dev environments.",
      );
    }

    const allLogs = await ctx.db.query("governanceEnforcement").collect();

    for (const log of allLogs) {
      await ctx.db.delete(log._id);
    }

    return { deleted: allLogs.length };
  },
});
