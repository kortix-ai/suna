/**
 * Cortex SDK - Memory Spaces Registry
 *
 * Hive/Collaboration Mode management
 * Memory space metadata and analytics
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations (Write Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Register a new memory space
 */
export const register = mutation({
  args: {
    memorySpaceId: v.string(),
    name: v.optional(v.string()),
    type: v.union(
      v.literal("personal"),
      v.literal("team"),
      v.literal("project"),
      v.literal("custom"),
    ),
    participants: v.optional(
      v.array(
        v.object({
          id: v.string(),
          type: v.string(), // "user", "agent", "tool", etc.
          joinedAt: v.number(),
        }),
      ),
    ),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Check if already exists
    const existing = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (existing) {
      throw new ConvexError("MEMORYSPACE_ALREADY_EXISTS");
    }

    const now = Date.now();

    const _id = await ctx.db.insert("memorySpaces", {
      memorySpaceId: args.memorySpaceId,
      name: args.name,
      type: args.type,
      participants: args.participants || [],
      metadata: args.metadata || {},
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(_id);
  },
});

/**
 * Update memory space metadata
 */
export const update = mutation({
  args: {
    memorySpaceId: v.string(),
    name: v.optional(v.string()),
    metadata: v.optional(v.any()),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    await ctx.db.patch(space._id, {
      name: args.name !== undefined ? args.name : space.name,
      metadata: args.metadata !== undefined ? args.metadata : space.metadata,
      status: args.status !== undefined ? args.status : space.status,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(space._id);
  },
});

/**
 * Add participant to memory space
 */
export const addParticipant = mutation({
  args: {
    memorySpaceId: v.string(),
    participant: v.object({
      id: v.string(),
      type: v.string(),
      joinedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    // Check if already exists
    if (space.participants.some((p) => p.id === args.participant.id)) {
      throw new ConvexError("PARTICIPANT_ALREADY_EXISTS");
    }

    await ctx.db.patch(space._id, {
      participants: [...space.participants, args.participant],
      updatedAt: Date.now(),
    });

    return await ctx.db.get(space._id);
  },
});

/**
 * Remove participant from memory space
 */
export const removeParticipant = mutation({
  args: {
    memorySpaceId: v.string(),
    participantId: v.string(),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    const updatedParticipants = space.participants.filter(
      (p) => p.id !== args.participantId,
    );

    await ctx.db.patch(space._id, {
      participants: updatedParticipants,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(space._id);
  },
});

/**
 * Archive memory space (marks as inactive but preserves data)
 */
export const archive = mutation({
  args: {
    memorySpaceId: v.string(),
    reason: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    await ctx.db.patch(space._id, {
      status: "archived",
      updatedAt: Date.now(),
      metadata: {
        ...space.metadata,
        ...(args.metadata || {}),
        archivedAt: Date.now(),
        archiveReason: args.reason,
      },
    });

    return await ctx.db.get(space._id);
  },
});

/**
 * Reactivate archived memory space
 */
export const reactivate = mutation({
  args: {
    memorySpaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    await ctx.db.patch(space._id, {
      status: "active",
      updatedAt: Date.now(),
    });

    return await ctx.db.get(space._id);
  },
});

/**
 * Delete memory space (also cascades to all data)
 */
export const deleteSpace = mutation({
  args: {
    memorySpaceId: v.string(),
    cascade: v.boolean(), // If true, delete all associated data
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    if (args.cascade) {
      // Delete all conversations
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId),
        )
        .collect();

      for (const conv of conversations) {
        await ctx.db.delete(conv._id);
      }

      // Delete all memories
      const memories = await ctx.db
        .query("memories")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId),
        )
        .collect();

      for (const mem of memories) {
        await ctx.db.delete(mem._id);
      }

      // Delete all facts
      const facts = await ctx.db
        .query("facts")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId),
        )
        .collect();

      for (const fact of facts) {
        await ctx.db.delete(fact._id);
      }
    }

    // Delete space itself
    await ctx.db.delete(space._id);

    return {
      deleted: true,
      memorySpaceId: args.memorySpaceId,
      cascaded: args.cascade,
    };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries (Read Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get memory space by ID
 */
export const get = query({
  args: {
    memorySpaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    return space || null;
  },
});

/**
 * List memory spaces
 */
export const list = query({
  args: {
    type: v.optional(
      v.union(
        v.literal("personal"),
        v.literal("team"),
        v.literal("project"),
        v.literal("custom"),
      ),
    ),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let spaces = await ctx.db
      .query("memorySpaces")
      .order("desc")
      .take(args.limit || 100);

    // Apply filters
    if (args.type) {
      spaces = spaces.filter((s) => s.type === args.type);
    }

    if (args.status) {
      spaces = spaces.filter((s) => s.status === args.status);
    }

    return spaces;
  },
});

/**
 * Count memory spaces
 */
export const count = query({
  args: {
    type: v.optional(
      v.union(
        v.literal("personal"),
        v.literal("team"),
        v.literal("project"),
        v.literal("custom"),
      ),
    ),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
  },
  handler: async (ctx, args) => {
    let spaces = await ctx.db.query("memorySpaces").collect();

    if (args.type) {
      spaces = spaces.filter((s) => s.type === args.type);
    }

    if (args.status) {
      spaces = spaces.filter((s) => s.status === args.status);
    }

    return spaces.length;
  },
});

/**
 * Get memory space statistics
 */
export const getStats = query({
  args: {
    memorySpaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    // Count conversations
    const conversationCount = await ctx.db
      .query("conversations")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect()
      .then((c) => c.length);

    // Count memories
    const memoryCount = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect()
      .then((m) => m.length);

    // Count facts
    const factCount = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect()
      .then((f) => f.filter((fact) => fact.supersededBy === undefined).length); // Active facts only

    // Calculate total messages
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    const messageCount = conversations.reduce(
      (sum, conv) => sum + conv.messageCount,
      0,
    );

    return {
      memorySpaceId: args.memorySpaceId,
      totalMemories: memoryCount,
      totalConversations: conversationCount,
      totalFacts: factCount,
      totalMessages: messageCount,
      storage: {
        conversationsBytes: 0, // TODO: Implement size calculation
        memoriesBytes: 0,
        factsBytes: 0,
        totalBytes: 0,
      },
      topTags: [], // TODO: Implement tag aggregation
      importanceBreakdown: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        trivial: 0,
      },
    };
  },
});

/**
 * Find memory spaces by participant
 */
export const findByParticipant = query({
  args: {
    participantId: v.string(),
  },
  handler: async (ctx, args) => {
    const allSpaces = await ctx.db.query("memorySpaces").collect();

    return allSpaces.filter((space) =>
      space.participants.some((p) => p.id === args.participantId),
    );
  },
});

/**
 * Search memory spaces by name or metadata
 */
export const search = query({
  args: {
    query: v.string(),
    type: v.optional(
      v.union(
        v.literal("personal"),
        v.literal("team"),
        v.literal("project"),
        v.literal("custom"),
      ),
    ),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let spaces = await ctx.db.query("memorySpaces").collect();

    // Apply type and status filters
    if (args.type) {
      spaces = spaces.filter((s) => s.type === args.type);
    }
    if (args.status) {
      spaces = spaces.filter((s) => s.status === args.status);
    }

    // Text search across name and metadata
    const queryLower = args.query.toLowerCase();
    spaces = spaces.filter((space) => {
      // Search in name
      if (space.name && space.name.toLowerCase().includes(queryLower)) {
        return true;
      }

      // Search in memorySpaceId
      if (space.memorySpaceId.toLowerCase().includes(queryLower)) {
        return true;
      }

      // Search in metadata (stringify and search)
      if (space.metadata) {
        const metadataStr = JSON.stringify(space.metadata).toLowerCase();
        if (metadataStr.includes(queryLower)) {
          return true;
        }
      }

      return false;
    });

    // Limit results
    return spaces.slice(0, args.limit || 50);
  },
});

/**
 * Update participants (combined add/remove)
 */
export const updateParticipants = mutation({
  args: {
    memorySpaceId: v.string(),
    add: v.optional(
      v.array(
        v.object({
          id: v.string(),
          type: v.string(),
          joinedAt: v.number(),
        }),
      ),
    ),
    remove: v.optional(v.array(v.string())), // Participant IDs to remove
  },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("memorySpaces")
      .withIndex("by_memorySpaceId", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .first();

    if (!space) {
      throw new ConvexError("MEMORYSPACE_NOT_FOUND");
    }

    let updatedParticipants = [...space.participants];

    // Remove participants
    if (args.remove && args.remove.length > 0) {
      updatedParticipants = updatedParticipants.filter(
        (p) => !args.remove!.includes(p.id),
      );
    }

    // Add new participants
    if (args.add && args.add.length > 0) {
      for (const newParticipant of args.add) {
        // Don't add duplicates
        if (!updatedParticipants.some((p) => p.id === newParticipant.id)) {
          updatedParticipants.push(newParticipant);
        }
      }
    }

    await ctx.db.patch(space._id, {
      participants: updatedParticipants,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(space._id);
  },
});

/**
 * Purge all memory spaces (TEST/DEV ONLY)
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

    const allSpaces = await ctx.db.query("memorySpaces").collect();

    for (const space of allSpaces) {
      await ctx.db.delete(space._id);
    }

    return { deleted: allSpaces.length };
  },
});
