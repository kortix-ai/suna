/**
 * Cortex SDK - Vector Memory API (Layer 2)
 *
 * Searchable agent-private memories with embeddings
 * References Layer 1 stores for full context
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations (Write Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Store a new vector memory
 */
export const store = mutation({
  args: {
    memorySpaceId: v.string(), // Updated
    participantId: v.optional(v.string()), // NEW: Hive Mode
    content: v.string(),
    contentType: v.union(
      v.literal("raw"),
      v.literal("summarized"),
      v.literal("fact"),
    ), // Added fact
    embedding: v.optional(v.array(v.float64())),
    sourceType: v.union(
      v.literal("conversation"),
      v.literal("system"),
      v.literal("tool"),
      v.literal("a2a"),
      v.literal("fact-extraction"), // NEW: For fact-extracted memories
    ),
    sourceUserId: v.optional(v.string()),
    sourceUserName: v.optional(v.string()),
    userId: v.optional(v.string()), // For user-owned memories
    agentId: v.optional(v.string()), // For agent-owned memories
    messageRole: v.optional(
      v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
    ), // NEW: For semantic search weighting
    // Enrichment fields (for bullet-proof retrieval)
    enrichedContent: v.optional(v.string()), // Concatenated searchable content for embedding
    factCategory: v.optional(v.string()), // Category for filtering (e.g., "addressing_preference")
    conversationRef: v.optional(
      v.object({
        conversationId: v.string(),
        messageIds: v.array(v.string()),
      }),
    ),
    immutableRef: v.optional(
      v.object({
        type: v.string(),
        id: v.string(),
        version: v.optional(v.number()),
      }),
    ),
    mutableRef: v.optional(
      v.object({
        namespace: v.string(),
        key: v.string(),
        snapshotValue: v.any(),
        snapshotAt: v.number(),
      }),
    ),
    factsRef: v.optional(
      v.object({
        factId: v.string(),
        version: v.optional(v.number()),
      }),
    ), // NEW: Reference to Layer 3 fact
    importance: v.number(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const memoryId = `mem-${now}-${Math.random().toString(36).substring(2, 11)}`;

    const _id = await ctx.db.insert("memories", {
      memoryId,
      memorySpaceId: args.memorySpaceId, // Updated
      participantId: args.participantId, // NEW
      content: args.content,
      contentType: args.contentType,
      embedding: args.embedding,
      sourceType: args.sourceType,
      sourceUserId: args.sourceUserId,
      sourceUserName: args.sourceUserName,
      sourceTimestamp: now,
      messageRole: args.messageRole, // NEW
      // Enrichment fields
      enrichedContent: args.enrichedContent,
      factCategory: args.factCategory,
      userId: args.userId,
      agentId: args.agentId, // NEW: Agent-owned memories support
      conversationRef: args.conversationRef,
      immutableRef: args.immutableRef,
      mutableRef: args.mutableRef,
      factsRef: args.factsRef, // NEW
      importance: args.importance,
      tags: args.tags,
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    });

    return await ctx.db.get(_id);
  },
});

/**
 * Store a partial memory (for streaming)
 * Creates a memory marked as in-progress
 */
export const storePartialMemory = mutation({
  args: {
    memorySpaceId: v.string(),
    participantId: v.optional(v.string()),
    conversationId: v.string(),
    userId: v.string(),
    content: v.string(),
    isPartial: v.boolean(),
    metadata: v.any(),
    importance: v.number(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const memoryId = `mem-partial-${now}-${Math.random().toString(36).substring(2, 11)}`;

    const _id = await ctx.db.insert("memories", {
      memoryId,
      memorySpaceId: args.memorySpaceId,
      participantId: args.participantId,
      content: args.content,
      contentType: "raw" as const,
      sourceType: "conversation" as const,
      sourceTimestamp: now,
      userId: args.userId,
      conversationRef: {
        conversationId: args.conversationId,
        messageIds: [],
      },
      importance: args.importance,
      tags: args.tags,
      version: 1,
      previousVersions: [],
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      // Store partial flag and metadata in a way Convex can handle
      isPartial: args.isPartial,
      partialMetadata: args.metadata,
    });

    return { memoryId, _id };
  },
});

/**
 * Update a partial memory (for streaming)
 * Updates content and metadata during streaming
 */
export const updatePartialMemory = mutation({
  args: {
    memoryId: v.string(),
    content: v.string(),
    metadata: v.any(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      throw new ConvexError("MEMORY_NOT_FOUND");
    }

    await ctx.db.patch(memory._id, {
      content: args.content,
      updatedAt: Date.now(),
      partialMetadata: args.metadata,
    });

    return { success: true };
  },
});

/**
 * Finalize a partial memory (for streaming)
 * Marks memory as complete and removes partial flag
 */
export const finalizePartialMemory = mutation({
  args: {
    memoryId: v.string(),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
    metadata: v.any(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      throw new ConvexError("MEMORY_NOT_FOUND");
    }

    // Remove streaming-related tags
    const finalTags = memory.tags.filter(
      (tag) => tag !== "streaming" && tag !== "partial",
    );

    await ctx.db.patch(memory._id, {
      content: args.content,
      embedding: args.embedding,
      updatedAt: Date.now(),
      isPartial: false,
      tags: finalTags,
      partialMetadata: args.metadata,
    });

    return { success: true };
  },
});

/**
 * Delete a memory
 */
export const deleteMemory = mutation({
  args: {
    memorySpaceId: v.string(), // Updated
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      throw new ConvexError("MEMORY_NOT_FOUND");
    }

    // Verify memorySpace owns this memory
    if (memory.memorySpaceId !== args.memorySpaceId) {
      throw new ConvexError("PERMISSION_DENIED");
    }

    await ctx.db.delete(memory._id);

    return { deleted: true, memoryId: args.memoryId };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries (Read Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get memory by ID
 */
export const get = query({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      return null;
    }

    // Verify memorySpace owns this memory
    if (memory.memorySpaceId !== args.memorySpaceId) {
      return null; // Permission denied (silent)
    }

    return memory;
  },
});

/**
 * Search memories (semantic with vector, keyword with text, or hybrid)
 */
export const search = query({
  args: {
    memorySpaceId: v.string(), // Updated
    query: v.string(),
    embedding: v.optional(v.array(v.float64())),
    userId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("a2a"),
      ),
    ),
    minImportance: v.optional(v.number()),
    minScore: v.optional(v.number()), // NEW: Minimum similarity score (0-1)
    queryCategory: v.optional(v.string()), // NEW: Category to boost (for bullet-proof retrieval)
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let results = [];

    if (args.embedding && args.embedding.length > 0) {
      // Semantic search with vector similarity
      // Try vector index first (production), fallback to manual similarity (local dev)
      try {
        // Note: .similar() API is only available in managed Convex, not local dev
        // TypeScript doesn't recognize it, so we use type assertion
        results = await ctx.db
          .query("memories")
          .withIndex("by_embedding" as any, (q: any) =>
            q
              .similar("embedding", args.embedding, args.limit || 20)
              .eq("memorySpaceId", args.memorySpaceId),
          )
          .collect();
      } catch (error: any) {
        // Fallback for local Convex (no vector index support)
        if (error.message?.includes("similar is not a function")) {
          const vectorResults = await ctx.db
            .query("memories")
            .withIndex("by_memorySpace", (q) =>
              q.eq("memorySpaceId", args.memorySpaceId),
            )
            .collect();

          // Calculate cosine similarity for each result
          const withScores = vectorResults
            .filter((m) => m.embedding && m.embedding.length > 0)
            .map((m) => {
              // Validate dimension matching (critical for correct similarity)
              if (m.embedding!.length !== args.embedding!.length) {
                // Skip embeddings with mismatched dimensions
                return {
                  ...m,
                  _score: -1, // Will be filtered out
                };
              }

              // Cosine similarity calculation
              let dotProduct = 0;
              let normA = 0;
              let normB = 0;

              for (let i = 0; i < args.embedding!.length; i++) {
                dotProduct += args.embedding![i] * m.embedding![i];
                normA += args.embedding![i] * args.embedding![i];
                normB += m.embedding![i] * m.embedding![i];
              }

              // Handle edge cases (zero vectors)
              const denominator = Math.sqrt(normA) * Math.sqrt(normB);
              const similarity = denominator > 0 ? dotProduct / denominator : 0;

              return {
                ...m,
                _score: similarity,
              };
            })
            .filter((m) => !isNaN(m._score) && m._score >= 0) // Filter out NaN and dimension mismatches
            .sort((a, b) => b._score - a._score) // Sort by similarity (highest first)
            .slice(0, args.limit || 20);

          results = withScores;
        } else {
          throw error;
        }
      }
    } else {
      // Keyword search
      results = await ctx.db
        .query("memories")
        .withSearchIndex("by_content", (q) =>
          q
            .search("content", args.query)
            .eq("memorySpaceId", args.memorySpaceId),
        )
        .take(args.limit || 20);
    }

    // Apply filters
    if (args.userId) {
      // Filter by sourceUserId (who the memory is about)
      results = results.filter(
        (m) => m.sourceUserId === args.userId || m.userId === args.userId,
      );
    }

    if (args.tags && args.tags.length > 0) {
      results = results.filter((m) =>
        args.tags!.some((tag) => m.tags.includes(tag)),
      );
    }

    if (args.sourceType) {
      results = results.filter((m) => m.sourceType === args.sourceType);
    }

    if (args.minImportance !== undefined) {
      results = results.filter((m) => m.importance >= args.minImportance!);
    }

    // Apply role-based and category-based weighting for semantic search (BEFORE filtering by minScore)
    // This helps user messages (facts about the user) rank higher than agent responses
    // And category-matched facts rank higher for bullet-proof retrieval
    if (args.embedding && args.embedding.length > 0) {
      results = results.map((m: any) => {
        let score = m._score ?? 0;

        // Role-based weighting for semantic search
        // User messages contain facts ABOUT the user (names, preferences, etc.)
        // Agent responses are typically acknowledgments, not facts worth searching
        if (m.messageRole === "user") {
          score *= 1.25; // 25% boost for user messages
        } else if (m.messageRole === "agent") {
          // Agent acknowledgments like "I've noted your email" are noise
          // Only penalize if content looks like an acknowledgment (short, no real facts)
          const content = (m.content || "").toLowerCase();
          const isAcknowledgment =
            content.length < 60 &&
            (content.includes("got it") ||
              content.includes("i've noted") ||
              content.includes("i'll remember") ||
              content.includes("noted") ||
              content.includes("understood") ||
              content.includes("i'll set") ||
              content.includes("i'll call"));
          if (isAcknowledgment) {
            score *= 0.5; // 50% penalty for pure acknowledgments
          }
        }

        // Category-based boosting for bullet-proof retrieval
        // Boost facts that match the query's category
        if (args.queryCategory && m.factCategory === args.queryCategory) {
          score *= 1.3; // 30% boost for matching category
        }

        // Additional boost for enriched content (facts with semantic context)
        if (m.enrichedContent) {
          score *= 1.1; // 10% boost for enriched facts
        }

        return {
          ...m,
          _score: score,
        };
      });

      // Re-sort after applying weights
      results.sort((a: any, b: any) => {
        const scoreA = a._score ?? 0;
        const scoreB = b._score ?? 0;
        return scoreB - scoreA;
      });
    }

    // Filter by minimum score (for semantic search)
    if (args.minScore !== undefined) {
      results = results.filter((m: any) => {
        // Only filter if _score exists (semantic search results)
        if (m._score !== undefined) {
          return m._score >= args.minScore!;
        }
        return true; // Keep all results without scores
      });
    }

    return results.slice(0, args.limit || 20);
  },
});

/**
 * List memories with filters
 */
export const list = query({
  args: {
    memorySpaceId: v.string(), // Updated
    userId: v.optional(v.string()),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("a2a"),
        v.literal("fact-extraction"), // NEW
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let memories = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      ) // Updated
      .order("desc")
      .take(args.limit || 100);

    // Apply filters
    if (args.userId) {
      memories = memories.filter((m) => m.userId === args.userId);
    }

    if (args.sourceType) {
      memories = memories.filter((m) => m.sourceType === args.sourceType);
    }

    return memories;
  },
});

/**
 * Count memories
 */
export const count = query({
  args: {
    memorySpaceId: v.string(), // Updated
    userId: v.optional(v.string()),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("a2a"),
        v.literal("fact-extraction"), // NEW
      ),
    ),
  },
  handler: async (ctx, args) => {
    let memories = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      ) // Updated
      .collect();

    // Apply filters
    if (args.userId) {
      memories = memories.filter((m) => m.userId === args.userId);
    }

    if (args.sourceType) {
      memories = memories.filter((m) => m.sourceType === args.sourceType);
    }

    return memories.length;
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Advanced Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Update a memory (creates new version)
 */
export const update = mutation({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
    content: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    importance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      throw new ConvexError("MEMORY_NOT_FOUND");
    }

    if (memory.memorySpaceId !== args.memorySpaceId) {
      throw new ConvexError("PERMISSION_DENIED");
    }

    const now = Date.now();
    const newVersion = memory.version + 1;

    // Add current to history
    const updatedPreviousVersions = [
      ...memory.previousVersions,
      {
        version: memory.version,
        content: memory.content,
        embedding: memory.embedding,
        timestamp: memory.updatedAt,
      },
    ];

    await ctx.db.patch(memory._id, {
      content: args.content || memory.content,
      embedding:
        args.embedding !== undefined ? args.embedding : memory.embedding,
      importance:
        args.importance !== undefined ? args.importance : memory.importance,
      tags: args.tags || memory.tags,
      version: newVersion,
      previousVersions: updatedPreviousVersions,
      updatedAt: now,
    });

    return await ctx.db.get(memory._id);
  },
});

/**
 * Get specific version
 */
export const getVersion = query({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
    version: v.number(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory || memory.memorySpaceId !== args.memorySpaceId) {
      return null;
    }

    if (args.version === memory.version) {
      return {
        memoryId: memory.memoryId,
        version: memory.version,
        content: memory.content,
        embedding: memory.embedding,
        timestamp: memory.updatedAt,
      };
    }

    const prevVersion = memory.previousVersions.find(
      (v) => v.version === args.version,
    );

    return prevVersion
      ? {
          memoryId: memory.memoryId,
          version: prevVersion.version,
          content: prevVersion.content,
          embedding: prevVersion.embedding,
          timestamp: prevVersion.timestamp,
        }
      : null;
  },
});

/**
 * Get version history
 */
export const getHistory = query({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory || memory.memorySpaceId !== args.memorySpaceId) {
      return [];
    }

    const history = [
      ...memory.previousVersions.map((v) => ({
        memoryId: memory.memoryId,
        version: v.version,
        content: v.content,
        embedding: v.embedding,
        timestamp: v.timestamp,
      })),
      {
        memoryId: memory.memoryId,
        version: memory.version,
        content: memory.content,
        embedding: memory.embedding,
        timestamp: memory.updatedAt,
      },
    ];

    return history.sort((a, b) => a.version - b.version);
  },
});

/**
 * Delete many memories
 */
export const deleteMany = mutation({
  args: {
    memorySpaceId: v.string(), // Updated
    userId: v.optional(v.string()),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("a2a"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    let memories = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    if (args.userId) {
      memories = memories.filter(
        (m) => m.userId === args.userId || m.sourceUserId === args.userId,
      );
    }

    if (args.sourceType) {
      memories = memories.filter((m) => m.sourceType === args.sourceType);
    }

    let deleted = 0;

    for (const memory of memories) {
      await ctx.db.delete(memory._id);
      deleted++;
    }

    return {
      deleted,
      memoryIds: memories.map((m) => m.memoryId),
    };
  },
});

/**
 * Delete multiple memories by their IDs (batch delete for cascade operations)
 * Much faster than calling deleteMemory multiple times
 * Uses index lookups instead of full table scan to avoid memory issues with large tables
 */
export const deleteByIds = mutation({
  args: {
    memoryIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const deletedIds: string[] = [];

    // Look up each memory by index to avoid full table scan
    // This is O(n) index lookups vs O(entire table) memory usage
    for (const memoryId of args.memoryIds) {
      const memory = await ctx.db
        .query("memories")
        .withIndex("by_memoryId", (q) => q.eq("memoryId", memoryId))
        .first();

      if (memory) {
        await ctx.db.delete(memory._id);
        deletedIds.push(memoryId);
      }
    }

    return {
      deleted: deletedIds.length,
      memoryIds: deletedIds,
    };
  },
});

/**
 * Purge ALL memories (test environments only - no agent filtering)
 * WARNING: This deletes ALL memories in the database
 *
 * SECURITY: Only enabled in test/dev environments
 * - Checks CONVEX_SITE_URL to prevent production misuse
 * - Local dev: localhost/127.0.0.1 URLs allowed
 * - Test deployments: dev-* deployment names allowed
 * - Production: Explicitly blocked
 */
export const purgeAll = mutation({
  args: {},
  handler: async (ctx) => {
    // Security check: Only allow in test/dev environments
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
        "PURGE_DISABLED_IN_PRODUCTION: purgeAll is only available in test/dev environments. " +
          "Use deleteMany with specific memorySpaceId for targeted deletions.",
      );
    }

    const allMemories = await ctx.db.query("memories").collect();

    let deleted = 0;

    for (const memory of allMemories) {
      await ctx.db.delete(memory._id);
      deleted++;
    }

    return { deleted };
  },
});

/**
 * Export memories
 */
export const exportMemories = query({
  args: {
    memorySpaceId: v.string(), // Updated
    userId: v.optional(v.string()),
    format: v.union(v.literal("json"), v.literal("csv")),
    includeEmbeddings: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    let memories = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    if (args.userId) {
      memories = memories.filter(
        (m) => m.userId === args.userId || m.sourceUserId === args.userId,
      );
    }

    if (args.format === "json") {
      const data = memories.map((m) => ({
        memoryId: m.memoryId,
        content: m.content,
        sourceType: m.sourceType,
        importance: m.importance,
        tags: m.tags,
        createdAt: m.createdAt,
        ...(args.includeEmbeddings && m.embedding
          ? { embedding: m.embedding }
          : {}),
      }));

      return {
        format: "json",
        data: JSON.stringify(data, null, 2),
        count: memories.length,
        exportedAt: Date.now(),
      };
    }
    const headers = [
      "memoryId",
      "content",
      "sourceType",
      "importance",
      "tags",
      "createdAt",
    ];
    const rows = memories.map((m) => [
      m.memoryId,
      m.content.replace(/,/g, ";"),
      m.sourceType,
      m.importance.toString(),
      m.tags.join(";"),
      new Date(m.createdAt).toISOString(),
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    return {
      format: "csv",
      data: csv,
      count: memories.length,
      exportedAt: Date.now(),
    };
  },
});

/**
 * Update many memories
 */
export const updateMany = mutation({
  args: {
    memorySpaceId: v.string(), // Updated
    userId: v.optional(v.string()),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("a2a"),
      ),
    ),
    importance: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    let memories = await ctx.db
      .query("memories")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    if (args.userId) {
      memories = memories.filter((m) => m.userId === args.userId);
    }

    if (args.sourceType) {
      memories = memories.filter((m) => m.sourceType === args.sourceType);
    }

    let updated = 0;

    for (const memory of memories) {
      const patches: any = { updatedAt: Date.now() };

      if (args.importance !== undefined) {
        patches.importance = args.importance;
      }

      if (args.tags) {
        patches.tags = args.tags;
      }

      await ctx.db.patch(memory._id, patches);
      updated++;
    }

    return {
      updated,
      memoryIds: memories.map((m) => m.memoryId),
    };
  },
});

/**
 * Archive memory (soft delete)
 */
export const archive = mutation({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      throw new ConvexError("MEMORY_NOT_FOUND");
    }

    if (memory.memorySpaceId !== args.memorySpaceId) {
      throw new ConvexError("PERMISSION_DENIED");
    }

    // Mark as archived by adding to tags
    const updatedTags = memory.tags.includes("archived")
      ? memory.tags
      : [...memory.tags, "archived"];

    await ctx.db.patch(memory._id, {
      tags: updatedTags,
      importance: Math.min(memory.importance, 10), // Reduce importance
      updatedAt: Date.now(),
    });

    return {
      archived: true,
      memoryId: args.memoryId,
      restorable: true,
    };
  },
});

/**
 * Restore memory from archive
 */
export const restoreFromArchive = mutation({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory) {
      throw new ConvexError("MEMORY_NOT_FOUND");
    }

    if (memory.memorySpaceId !== args.memorySpaceId) {
      throw new ConvexError("PERMISSION_DENIED");
    }

    // Check if memory is archived
    if (!memory.tags.includes("archived")) {
      throw new ConvexError("MEMORY_NOT_ARCHIVED");
    }

    // Remove archived tag
    const updatedTags = memory.tags.filter((tag) => tag !== "archived");

    // Restore importance to a reasonable default if it was reduced
    const restoredImportance = memory.importance < 50 ? 50 : memory.importance;

    await ctx.db.patch(memory._id, {
      tags: updatedTags,
      importance: restoredImportance,
      updatedAt: Date.now(),
    });

    return {
      restored: true,
      memoryId: args.memoryId,
      memory: await ctx.db.get(memory._id),
    };
  },
});

/**
 * Get version at specific timestamp
 */
export const getAtTimestamp = query({
  args: {
    memorySpaceId: v.string(),
    memoryId: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_memoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();

    if (!memory || memory.memorySpaceId !== args.memorySpaceId) {
      return null;
    }

    // If timestamp is after current version
    if (args.timestamp >= memory.updatedAt) {
      return {
        memoryId: memory.memoryId,
        version: memory.version,
        content: memory.content,
        embedding: memory.embedding,
        timestamp: memory.updatedAt,
      };
    }

    // If before creation
    if (args.timestamp < memory.createdAt) {
      return null;
    }

    // Find version that was current at timestamp
    for (let i = memory.previousVersions.length - 1; i >= 0; i--) {
      const prevVersion = memory.previousVersions[i];

      if (args.timestamp >= prevVersion.timestamp) {
        return {
          memoryId: memory.memoryId,
          version: prevVersion.version,
          content: prevVersion.content,
          embedding: prevVersion.embedding,
          timestamp: prevVersion.timestamp,
        };
      }
    }

    return null;
  },
});
