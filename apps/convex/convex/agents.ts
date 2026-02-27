/**
 * Cortex Convex Functions - Agents Registry API
 *
 * Backend functions for optional agent metadata registration.
 * Agents work without registration - this is just for discovery and analytics.
 */

import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get agent registration by ID
 */
export const get = query({
  args: {
    agentId: v.string(),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    return agent;
  },
});

/**
 * List agents with optional filters
 */
export const list = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("inactive"),
        v.literal("archived"),
      ),
    ),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let query;

    if (args.status) {
      query = ctx.db
        .query("agents")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc");
    } else {
      query = ctx.db.query("agents").withIndex("by_registered").order("desc");
    }

    if (args.offset) {
      // Skip first N results
      const allResults = await query.collect();
      const sliced = allResults.slice(
        args.offset,
        args.offset + (args.limit || 100),
      );
      return sliced;
    }

    if (args.limit) {
      return await query.take(args.limit);
    }

    return await query.take(100); // Default limit
  },
});

/**
 * Count agents
 */
export const count = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("inactive"),
        v.literal("archived"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    let agents;

    if (args.status) {
      agents = await ctx.db
        .query("agents")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    } else {
      agents = await ctx.db.query("agents").collect();
    }

    return agents.length;
  },
});

/**
 * Check if agent exists
 */
export const exists = query({
  args: {
    agentId: v.string(),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    return agent !== null;
  },
});

/**
 * Compute agent statistics
 */
export const computeStats = query({
  args: {
    agentId: v.string(),
  },
  handler: async (ctx, args) => {
    // Count memories where participantId = agentId
    const memories = await ctx.db
      .query("memories")
      .filter((q) => q.eq(q.field("participantId"), args.agentId))
      .collect();

    // Count conversations where agent is participant
    const conversations = await ctx.db
      .query("conversations")
      .filter((q) =>
        q.or(
          q.eq(q.field("participants.participantId"), args.agentId),
          // Check if agentId is in memorySpaceIds array (for agent-agent convos)
          q.eq(q.field("memorySpaceId"), args.agentId),
        ),
      )
      .collect();

    // Count facts where participantId = agentId
    const facts = await ctx.db
      .query("facts")
      .filter((q) => q.eq(q.field("participantId"), args.agentId))
      .collect();

    // Find unique memory spaces
    const memorySpaces = new Set(memories.map((m) => m.memorySpaceId));

    // Find last active time
    const allTimestamps = [
      ...memories.map((m) => m.updatedAt),
      ...conversations.map((c) => c.updatedAt),
      ...facts.map((f) => f.updatedAt),
    ];

    const lastActive =
      allTimestamps.length > 0 ? Math.max(...allTimestamps) : undefined;

    return {
      totalMemories: memories.length,
      totalConversations: conversations.length,
      totalFacts: facts.length,
      memorySpacesActive: memorySpaces.size,
      lastActive,
    };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutation Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Register an agent
 */
export const register = mutation({
  args: {
    agentId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    metadata: v.optional(v.any()),
    config: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Check if agent already registered
    const existing = await ctx.db
      .query("agents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    if (existing) {
      throw new ConvexError("AGENT_ALREADY_REGISTERED");
    }

    const now = Date.now();

    const agentId = await ctx.db.insert("agents", {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      metadata: args.metadata || {},
      config: args.config || {},
      status: "active",
      registeredAt: now,
      updatedAt: now,
    });

    const agent = await ctx.db.get(agentId);
    return agent;
  },
});

/**
 * Update agent registration
 */
export const update = mutation({
  args: {
    agentId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    metadata: v.optional(v.any()),
    config: v.optional(v.any()),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("inactive"),
        v.literal("archived"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    if (!agent) {
      throw new ConvexError("AGENT_NOT_REGISTERED");
    }

    // Build update object
    const updates: any = {
      updatedAt: Date.now(),
    };

    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.metadata !== undefined) updates.metadata = args.metadata;
    if (args.config !== undefined) updates.config = args.config;
    if (args.status !== undefined) updates.status = args.status;

    await ctx.db.patch(agent._id, updates);

    const updated = await ctx.db.get(agent._id);
    return updated;
  },
});

/**
 * Unregister agent (just removes registration, cascade handled in SDK)
 */
export const unregister = mutation({
  args: {
    agentId: v.string(),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    if (!agent) {
      throw new ConvexError("AGENT_NOT_REGISTERED");
    }

    await ctx.db.delete(agent._id);

    return { deleted: true, agentId: args.agentId };
  },
});

/**
 * Unregister multiple agents matching filters
 *
 * Note: This only removes registrations. Cascade deletion of agent data
 * is handled in the SDK layer for each agent.
 */
export const unregisterMany = mutation({
  args: {
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("inactive"),
        v.literal("archived"),
      ),
    ),
    agentIds: v.optional(v.array(v.string())), // Specific agent IDs
  },
  handler: async (ctx, args) => {
    let agents;

    if (args.agentIds && args.agentIds.length > 0) {
      // Delete specific agents
      agents = await Promise.all(
        args.agentIds.map((agentId) =>
          ctx.db
            .query("agents")
            .withIndex("by_agentId", (q) => q.eq("agentId", agentId))
            .first(),
        ),
      );
      agents = agents.filter((a) => a !== null);
    } else if (args.status) {
      // Delete by status filter
      agents = await ctx.db
        .query("agents")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    } else {
      throw new Error(
        "INVALID_FILTERS: Must provide agentIds or status filter",
      );
    }

    const deletedAgentIds: string[] = [];

    for (const agent of agents) {
      try {
        await ctx.db.delete(agent._id);
        deletedAgentIds.push(agent.agentId);
      } catch (error) {
        console.error(`Failed to unregister agent ${agent.agentId}:`, error);
        // Continue with other agents
      }
    }

    return {
      deleted: deletedAgentIds.length,
      agentIds: deletedAgentIds,
    };
  },
});

/**
 * Note: Cascade deletion by participantId is orchestrated in the SDK layer.
 *
 * The SDK will:
 * 1. Query all memory spaces
 * 2. For each space, find records where participantId = agentId
 * 3. Delete conversations, memories, facts, graph nodes
 * 4. Delete agent registration (last)
 * 5. Verify completeness and rollback on failure
 *
 * This approach provides better control and error handling than a single
 * complex backend mutation.
 */

/**
 * Purge all agents (TEST/DEV ONLY)
 *
 * WARNING: This permanently deletes ALL agent registrations!
 * Only available in test/dev environments.
 */
export const purgeAll = mutation({
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
        "PURGE_DISABLED_IN_PRODUCTION: purgeAll is only available in test/dev environments.",
      );
    }

    const allAgents = await ctx.db.query("agents").collect();

    for (const agent of allAgents) {
      await ctx.db.delete(agent._id);
    }

    return { deleted: allAgents.length };
  },
});
