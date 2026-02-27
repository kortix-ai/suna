/**
 * Cortex SDK - Conversations API (Layer 1a)
 *
 * ACID-compliant immutable conversation storage
 * memorySpace-scoped with participantId tracking (Hive Mode)
 * Two types: user-agent, agent-agent (Collaboration Mode)
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations (Write Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Create a new conversation
 */
export const create = mutation({
  args: {
    conversationId: v.string(),
    memorySpaceId: v.string(), // NEW: Required - which memory space owns this
    participantId: v.optional(v.string()), // NEW: Hive Mode participant tracking
    type: v.union(v.literal("user-agent"), v.literal("agent-agent")),
    participants: v.object({
      userId: v.optional(v.string()), // The human user in the conversation
      agentId: v.optional(v.string()), // The agent/assistant in the conversation
      participantId: v.optional(v.string()), // Hive Mode: who created this
      memorySpaceIds: v.optional(v.array(v.string())), // Collaboration Mode: cross-space
    }),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Validate participants based on type
    if (args.type === "user-agent") {
      if (!args.participants.userId) {
        throw new ConvexError("user-agent conversations require userId");
      }
      // v0.17.0: User-agent conversations require both userId AND agentId
      if (!args.participants.agentId) {
        throw new ConvexError(
          "agentId is required when userId is provided. User-agent conversations require both a user and an agent participant.",
        );
      }
    } else if (args.type === "agent-agent") {
      if (
        !args.participants.memorySpaceIds ||
        args.participants.memorySpaceIds.length < 2
      ) {
        throw new ConvexError(
          "agent-agent conversations require at least 2 memorySpaceIds",
        );
      }
    }

    // Check if conversation already exists
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (existing) {
      throw new ConvexError("CONVERSATION_ALREADY_EXISTS");
    }

    const now = Date.now();

    // Create conversation
    const id = await ctx.db.insert("conversations", {
      conversationId: args.conversationId,
      memorySpaceId: args.memorySpaceId,
      participantId: args.participantId,
      type: args.type,
      participants: args.participants,
      messages: [],
      messageCount: 0,
      metadata: args.metadata || {},
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(id);
  },
});

/**
 * Add a message to an existing conversation (append-only)
 */
export const addMessage = mutation({
  args: {
    conversationId: v.string(),
    message: v.object({
      id: v.string(),
      role: v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
      content: v.string(),
      participantId: v.optional(v.string()), // Hive Mode: which participant sent this
      metadata: v.optional(v.any()),
    }),
  },
  handler: async (ctx, args) => {
    // Get conversation
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (!conversation) {
      throw new ConvexError("CONVERSATION_NOT_FOUND");
    }

    // Create message with timestamp
    const message = {
      ...args.message,
      timestamp: Date.now(),
    };

    // Append message (immutable - never modify existing messages)
    await ctx.db.patch(conversation._id, {
      messages: [...conversation.messages, message],
      messageCount: conversation.messageCount + 1,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(conversation._id);
  },
});

/**
 * Delete a conversation (for GDPR/cleanup)
 */
export const deleteConversation = mutation({
  args: {
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (!conversation) {
      throw new ConvexError("CONVERSATION_NOT_FOUND");
    }

    await ctx.db.delete(conversation._id);

    return { deleted: true };
  },
});

/**
 * Delete many conversations matching filters
 */
export const deleteMany = mutation({
  args: {
    userId: v.optional(v.string()),
    memorySpaceId: v.optional(v.string()), // NEW: Filter by memory space
    type: v.optional(
      v.union(v.literal("user-agent"), v.literal("agent-agent")),
    ),
  },
  handler: async (ctx, args) => {
    let conversations;

    // Use index if memorySpaceId provided (fast)
    if (args.memorySpaceId) {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId!),
        )
        .collect();
    } else {
      conversations = await ctx.db.query("conversations").collect();
    }

    // Apply additional filters
    if (args.userId) {
      conversations = conversations.filter(
        (c) => c.participants.userId === args.userId,
      );
    }

    if (args.type) {
      conversations = conversations.filter((c) => c.type === args.type);
    }

    let deleted = 0;
    let totalMessagesDeleted = 0;

    for (const conversation of conversations) {
      totalMessagesDeleted += conversation.messageCount;
      await ctx.db.delete(conversation._id);
      deleted++;
    }

    return {
      deleted,
      totalMessagesDeleted,
      conversationIds: conversations.map((c) => c.conversationId),
    };
  },
});

/**
 * Delete multiple conversations by their IDs (batch delete for cascade operations)
 * Much faster than calling deleteConversation multiple times
 * Uses index lookups instead of full table scan to avoid memory issues with large tables
 */
export const deleteByIds = mutation({
  args: {
    conversationIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const deletedIds: string[] = [];
    let totalMessagesDeleted = 0;

    // Look up each conversation by index to avoid full table scan
    // This is O(n) index lookups vs O(entire table) memory usage
    for (const conversationId of args.conversationIds) {
      const conversation = await ctx.db
        .query("conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", conversationId),
        )
        .first();

      if (conversation) {
        totalMessagesDeleted += conversation.messageCount;
        await ctx.db.delete(conversation._id);
        deletedIds.push(conversationId);
      }
    }

    return {
      deleted: deletedIds.length,
      conversationIds: deletedIds,
      totalMessagesDeleted,
    };
  },
});

/**
 * Purge ALL conversations (development/testing only)
 */
export const purgeAll = mutation({
  args: {},
  handler: async (ctx) => {
    const conversations = await ctx.db.query("conversations").collect();

    let deleted = 0;
    let totalMessagesDeleted = 0;

    for (const conversation of conversations) {
      totalMessagesDeleted += conversation.messageCount;
      await ctx.db.delete(conversation._id);
      deleted++;
    }

    return {
      deleted,
      totalMessagesDeleted,
    };
  },
});

/**
 * Get a specific message by ID from a conversation
 */
export const getMessage = query({
  args: {
    conversationId: v.string(),
    messageId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (!conversation) {
      return null;
    }

    const message = conversation.messages.find((m) => m.id === args.messageId);

    return message || null;
  },
});

/**
 * Get multiple messages by their IDs
 */
export const getMessagesByIds = query({
  args: {
    conversationId: v.string(),
    messageIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (!conversation) {
      return [];
    }

    const messages = conversation.messages.filter((m) =>
      args.messageIds.includes(m.id),
    );

    return messages;
  },
});

/**
 * Get or create a conversation (atomic)
 */
export const getOrCreate = mutation({
  args: {
    memorySpaceId: v.string(), // NEW: Required
    participantId: v.optional(v.string()), // NEW: Hive Mode
    type: v.union(v.literal("user-agent"), v.literal("agent-agent")),
    participants: v.object({
      userId: v.optional(v.string()),
      agentId: v.optional(v.string()), // v0.17.0: Required for user-agent conversations
      participantId: v.optional(v.string()),
      memorySpaceIds: v.optional(v.array(v.string())),
    }),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Try to find existing
    let existing = null;

    if (args.type === "user-agent") {
      if (!args.participants.userId) {
        throw new ConvexError("user-agent conversations require userId");
      }
      // v0.17.0: User-agent conversations require both userId AND agentId
      if (!args.participants.agentId) {
        throw new ConvexError(
          "agentId is required when userId is provided. User-agent conversations require both a user and an agent participant.",
        );
      }

      // Look for existing in this memory space with this user AND agent
      // v0.17.0: Must match agentId to support multiple agents per user/space
      existing = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace_user", (q) =>
          q
            .eq("memorySpaceId", args.memorySpaceId!)
            .eq("participants.userId", args.participants.userId),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("type"), "user-agent"),
            q.eq(q.field("participants.agentId"), args.participants.agentId),
          ),
        )
        .first();
    } else {
      // agent-agent (Collaboration Mode)
      if (
        !args.participants.memorySpaceIds ||
        args.participants.memorySpaceIds.length < 2
      ) {
        throw new ConvexError(
          "agent-agent conversations require at least 2 memorySpaceIds",
        );
      }

      const conversations = await ctx.db
        .query("conversations")
        .filter((q) => q.eq(q.field("type"), "agent-agent"))
        .collect();

      const sortedInput = [...args.participants.memorySpaceIds].sort();

      existing =
        conversations.find((c) => {
          if (!c.participants.memorySpaceIds) {
            return false;
          }
          const sorted = [...c.participants.memorySpaceIds].sort();

          return (
            sorted.length === sortedInput.length &&
            sorted.every((id, i) => id === sortedInput[i])
          );
        }) || null;
    }

    if (existing) {
      return existing;
    }

    // Create new
    const now = Date.now();
    const conversationId = `conv-${now}-${Math.random().toString(36).substring(2, 11)}`;

    const _id = await ctx.db.insert("conversations", {
      conversationId,
      memorySpaceId: args.memorySpaceId,
      participantId: args.participantId,
      type: args.type,
      participants: args.participants,
      messages: [],
      messageCount: 0,
      metadata: args.metadata || {},
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(_id);
  },
});

/**
 * Find an existing conversation by participants
 */
export const findConversation = query({
  args: {
    memorySpaceId: v.string(), // NEW: Required
    type: v.union(v.literal("user-agent"), v.literal("agent-agent")),
    userId: v.optional(v.string()),
    memorySpaceIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    if (args.type === "user-agent") {
      if (!args.userId) {
        return null;
      }

      // Find user-agent conversation in this memory space
      const conversation = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace_user", (q) =>
          q
            .eq("memorySpaceId", args.memorySpaceId!)
            .eq("participants.userId", args.userId),
        )
        .filter((q) => q.eq(q.field("type"), "user-agent"))
        .first();

      return conversation || null;
    }
    // agent-agent conversation (Collaboration Mode)
    if (!args.memorySpaceIds || args.memorySpaceIds.length < 2) {
      return null;
    }

    // Find by matching memorySpaceIds array
    const conversations = await ctx.db
      .query("conversations")
      .filter((q) => q.eq(q.field("type"), "agent-agent"))
      .collect();

    // Find conversation with exact same memory spaces (any order)
    const sortedInput = [...args.memorySpaceIds].sort();
    const found = conversations.find((c) => {
      if (!c.participants.memorySpaceIds) {
        return false;
      }
      const sorted = [...c.participants.memorySpaceIds].sort();

      return (
        sorted.length === sortedInput.length &&
        sorted.every((id, i) => id === sortedInput[i])
      );
    });

    return found || null;
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries (Read Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get a single conversation by ID
 */
export const get = query({
  args: {
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (!conversation) {
      return null;
    }

    return conversation;
  },
});

/**
 * List conversations with filters
 */
export const list = query({
  args: {
    type: v.optional(
      v.union(v.literal("user-agent"), v.literal("agent-agent")),
    ),
    userId: v.optional(v.string()),
    memorySpaceId: v.optional(v.string()), // NEW: Filter by memory space
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Apply filters using indexes
    let conversations;

    // Prioritize memorySpace + user (most common query pattern)
    if (args.memorySpaceId && args.userId) {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace_user", (q) =>
          q
            .eq("memorySpaceId", args.memorySpaceId!)
            .eq("participants.userId", args.userId),
        )
        .order("desc")
        .take(args.limit || 100);
    } else if (args.memorySpaceId) {
      // Memory space only (Hive Mode: all conversations in space)
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId!),
        )
        .order("desc")
        .take(args.limit || 100);
    } else if (args.userId) {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_user", (q) => q.eq("participants.userId", args.userId))
        .order("desc")
        .take(args.limit || 100);
    } else if (args.type) {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_type", (q) => q.eq("type", args.type!))
        .order("desc")
        .take(args.limit || 100);
    } else {
      conversations = await ctx.db
        .query("conversations")
        .order("desc")
        .take(args.limit || 100);
    }

    // Post-filter by type if needed (when using other indexes)
    if (args.type && (args.memorySpaceId || args.userId)) {
      return conversations.filter((c) => c.type === args.type);
    }

    return conversations;
  },
});

/**
 * Count conversations
 */
export const count = query({
  args: {
    userId: v.optional(v.string()),
    memorySpaceId: v.optional(v.string()), // NEW
    type: v.optional(
      v.union(v.literal("user-agent"), v.literal("agent-agent")),
    ),
  },
  handler: async (ctx, args) => {
    let conversations;

    // Use index if memorySpaceId provided
    if (args.memorySpaceId) {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId!),
        )
        .collect();
    } else {
      conversations = await ctx.db.query("conversations").collect();
    }

    let filtered = conversations;

    if (args.userId) {
      filtered = filtered.filter((c) => c.participants.userId === args.userId);
    }

    if (args.type) {
      filtered = filtered.filter((c) => c.type === args.type);
    }

    return filtered.length;
  },
});

/**
 * Get paginated message history from a conversation
 */
export const getHistory = query({
  args: {
    conversationId: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .first();

    if (!conversation) {
      throw new ConvexError("CONVERSATION_NOT_FOUND");
    }

    const limit = args.limit || 50;
    const offset = args.offset || 0;
    const sortOrder = args.sortOrder || "asc";

    // Get messages (already sorted in storage as append-only)
    let { messages } = conversation;

    // Reverse if descending (newest first)
    if (sortOrder === "desc") {
      messages = [...messages].reverse();
    }

    // Paginate
    const paginatedMessages = messages.slice(offset, offset + limit);

    return {
      messages: paginatedMessages,
      total: conversation.messageCount,
      hasMore: offset + limit < conversation.messageCount,
      conversationId: conversation.conversationId,
    };
  },
});

/**
 * Search conversations by text query
 */
export const search = query({
  args: {
    query: v.string(),
    type: v.optional(
      v.union(v.literal("user-agent"), v.literal("agent-agent")),
    ),
    userId: v.optional(v.string()),
    memorySpaceId: v.optional(v.string()), // NEW: Filter by memory space
    dateStart: v.optional(v.number()),
    dateEnd: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Get conversations (use index if memorySpace provided)
    let allConversations;

    if (args.memorySpaceId) {
      allConversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId!),
        )
        .collect();
    } else {
      allConversations = await ctx.db.query("conversations").collect();
    }

    const searchQuery = args.query.toLowerCase();
    const results: Array<{
      conversation: unknown;
      matchedMessages: unknown[];
      highlights: string[];
      score: number;
    }> = [];

    for (const conversation of allConversations) {
      // Apply filters
      if (args.type && conversation.type !== args.type) {
        continue;
      }
      if (args.userId && conversation.participants.userId !== args.userId) {
        continue;
      }
      if (args.dateStart && conversation.createdAt < args.dateStart) {
        continue;
      }
      if (args.dateEnd && conversation.createdAt > args.dateEnd) {
        continue;
      }

      // Search in messages
      const matchedMessages = conversation.messages.filter((msg: any) =>
        msg.content.toLowerCase().includes(searchQuery),
      );

      if (matchedMessages.length > 0) {
        // Calculate score based on matches
        const score = matchedMessages.length / conversation.messageCount;

        // Extract highlights
        const highlights = matchedMessages.slice(0, 3).map((msg: any) => {
          const { content } = msg;
          const index = content.toLowerCase().indexOf(searchQuery);
          const start = Math.max(0, index - 30);
          const end = Math.min(content.length, index + searchQuery.length + 30);

          return content.substring(start, end);
        });

        results.push({
          conversation,
          matchedMessages,
          highlights,
          score,
        });
      }
    }

    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);

    // Limit results
    const limited = results.slice(0, args.limit || 10);

    return limited;
  },
});

/**
 * Export conversations to JSON or CSV
 */
export const exportConversations = query({
  args: {
    userId: v.optional(v.string()),
    memorySpaceId: v.optional(v.string()), // NEW: Filter by memory space
    conversationIds: v.optional(v.array(v.string())),
    type: v.optional(
      v.union(v.literal("user-agent"), v.literal("agent-agent")),
    ),
    dateStart: v.optional(v.number()),
    dateEnd: v.optional(v.number()),
    format: v.union(v.literal("json"), v.literal("csv")),
    includeMetadata: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    let conversations;

    // Use index if memorySpaceId provided
    if (args.memorySpaceId) {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_memorySpace", (q) =>
          q.eq("memorySpaceId", args.memorySpaceId!),
        )
        .collect();
    } else {
      conversations = await ctx.db.query("conversations").collect();
    }

    // Apply filters
    if (args.conversationIds && args.conversationIds.length > 0) {
      conversations = conversations.filter((c) =>
        args.conversationIds!.includes(c.conversationId),
      );
    }

    if (args.userId) {
      conversations = conversations.filter(
        (c) => c.participants.userId === args.userId,
      );
    }

    if (args.type) {
      conversations = conversations.filter((c) => c.type === args.type);
    }

    if (args.dateStart) {
      conversations = conversations.filter(
        (c) => c.createdAt >= args.dateStart!,
      );
    }

    if (args.dateEnd) {
      conversations = conversations.filter((c) => c.createdAt <= args.dateEnd!);
    }

    // Format data
    if (args.format === "json") {
      const data = conversations.map((c) => {
        const exported: unknown = {
          conversationId: c.conversationId,
          type: c.type,
          participants: c.participants,
          messages: c.messages,
          messageCount: c.messageCount,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };

        if (args.includeMetadata && c.metadata) {
          (exported as any).metadata = c.metadata;
        }

        return exported;
      });

      return {
        format: "json",
        data: JSON.stringify(data, null, 2),
        count: conversations.length,
        exportedAt: Date.now(),
      };
    }
    // CSV format
    const headers = [
      "conversationId",
      "type",
      "participants",
      "messageCount",
      "createdAt",
      "updatedAt",
    ];

    if (args.includeMetadata) {
      headers.push("metadata");
    }

    const rows = conversations.map((c) => {
      const row = [
        c.conversationId,
        c.type,
        JSON.stringify(c.participants),
        c.messageCount.toString(),
        new Date(c.createdAt).toISOString(),
        new Date(c.updatedAt).toISOString(),
      ];

      if (args.includeMetadata) {
        row.push(JSON.stringify(c.metadata || {}));
      }

      return row.join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");

    return {
      format: "csv",
      data: csv,
      count: conversations.length,
      exportedAt: Date.now(),
    };
  },
});
