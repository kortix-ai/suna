/**
 * Cortex SDK - Facts Store API (Layer 3)
 *
 * LLM-extracted, memorySpace-scoped, versioned facts
 * Structured knowledge with relationships
 */

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations (Write Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Store a new fact
 */
export const store = mutation({
  args: {
    memorySpaceId: v.string(),
    participantId: v.optional(v.string()), // Hive Mode: who extracted this fact
    userId: v.optional(v.string()), // GDPR compliance - links to user
    fact: v.string(), // The fact statement
    factType: v.union(
      v.literal("preference"),
      v.literal("identity"),
      v.literal("knowledge"),
      v.literal("relationship"),
      v.literal("event"),
      v.literal("observation"),
      v.literal("custom"),
    ),
    subject: v.optional(v.string()), // Primary entity (e.g., "user-123")
    predicate: v.optional(v.string()), // Relationship (e.g., "prefers", "works_at")
    object: v.optional(v.string()), // Secondary entity (e.g., "dark mode")
    confidence: v.number(), // 0-100: extraction confidence
    sourceType: v.union(
      v.literal("conversation"),
      v.literal("system"),
      v.literal("tool"),
      v.literal("manual"),
      v.literal("a2a"),
    ),
    sourceRef: v.optional(
      v.object({
        conversationId: v.optional(v.string()),
        messageIds: v.optional(v.array(v.string())),
        memoryId: v.optional(v.string()),
      }),
    ),
    metadata: v.optional(v.any()),
    tags: v.array(v.string()),
    validFrom: v.optional(v.number()), // Temporal validity
    validUntil: v.optional(v.number()),
    // Enrichment fields (for bullet-proof retrieval)
    category: v.optional(v.string()), // Specific sub-category (e.g., "addressing_preference")
    searchAliases: v.optional(v.array(v.string())), // Alternative search terms
    semanticContext: v.optional(v.string()), // Usage context sentence
    entities: v.optional(
      v.array(
        v.object({
          name: v.string(),
          type: v.string(),
          fullValue: v.optional(v.string()),
        }),
      ),
    ), // Extracted entities with types
    relations: v.optional(
      v.array(
        v.object({
          subject: v.string(),
          predicate: v.string(),
          object: v.string(),
        }),
      ),
    ), // Subject-predicate-object triples for graph
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const factId = `fact-${now}-${Math.random().toString(36).substring(2, 11)}`;

    const _id = await ctx.db.insert("facts", {
      factId,
      memorySpaceId: args.memorySpaceId,
      participantId: args.participantId,
      userId: args.userId,
      fact: args.fact,
      factType: args.factType,
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      confidence: args.confidence,
      sourceType: args.sourceType,
      sourceRef: args.sourceRef,
      metadata: args.metadata,
      tags: args.tags,
      validFrom: args.validFrom || now,
      validUntil: args.validUntil,
      // Enrichment fields
      category: args.category,
      searchAliases: args.searchAliases,
      semanticContext: args.semanticContext,
      entities: args.entities,
      relations: args.relations,
      version: 1,
      supersededBy: undefined,
      supersedes: undefined,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(_id);
  },
});

/**
 * Update a fact (creates new version, marks old as superseded)
 */
export const update = mutation({
  args: {
    memorySpaceId: v.string(),
    factId: v.string(),
    fact: v.optional(v.string()),
    confidence: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    validUntil: v.optional(v.number()),
    metadata: v.optional(v.any()),
    // Enrichment fields (for bullet-proof retrieval)
    category: v.optional(v.string()),
    searchAliases: v.optional(v.array(v.string())),
    semanticContext: v.optional(v.string()),
    entities: v.optional(
      v.array(
        v.object({
          name: v.string(),
          type: v.string(),
          fullValue: v.optional(v.string()),
        }),
      ),
    ),
    relations: v.optional(
      v.array(
        v.object({
          subject: v.string(),
          predicate: v.string(),
          object: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();

    if (!existing) {
      throw new ConvexError("FACT_NOT_FOUND");
    }

    // Verify memorySpace owns this fact
    if (existing.memorySpaceId !== args.memorySpaceId) {
      throw new ConvexError("PERMISSION_DENIED");
    }

    const now = Date.now();
    const newFactId = `fact-${now}-${Math.random().toString(36).substring(2, 11)}`;

    // Create new version (manually copy fields to avoid _id/_creationTime)
    const _id = await ctx.db.insert("facts", {
      factId: newFactId,
      memorySpaceId: existing.memorySpaceId,
      participantId: existing.participantId,
      userId: existing.userId, // GDPR compliance - preserve user link across versions
      fact: args.fact || existing.fact,
      factType: existing.factType,
      subject: existing.subject,
      predicate: existing.predicate,
      object: existing.object,
      confidence:
        args.confidence !== undefined ? args.confidence : existing.confidence,
      sourceType: existing.sourceType,
      sourceRef: existing.sourceRef,
      metadata: args.metadata || existing.metadata,
      tags: args.tags || existing.tags,
      validFrom: existing.validFrom,
      validUntil:
        args.validUntil !== undefined ? args.validUntil : existing.validUntil,
      // Enrichment fields - preserve from existing or update
      category: args.category !== undefined ? args.category : existing.category,
      searchAliases:
        args.searchAliases !== undefined
          ? args.searchAliases
          : existing.searchAliases,
      semanticContext:
        args.semanticContext !== undefined
          ? args.semanticContext
          : existing.semanticContext,
      entities: args.entities !== undefined ? args.entities : existing.entities,
      relations:
        args.relations !== undefined ? args.relations : existing.relations,
      version: existing.version + 1,
      supersedes: existing.factId, // Link to previous
      supersededBy: undefined,
      createdAt: existing.createdAt, // Preserve original creation time across versions
      updatedAt: now,
    });

    // Mark old as superseded
    await ctx.db.patch(existing._id, {
      supersededBy: newFactId,
      validUntil: now,
    });

    return await ctx.db.get(_id);
  },
});

/**
 * Delete a fact (soft delete - mark as invalidated)
 */
export const deleteFact = mutation({
  args: {
    memorySpaceId: v.string(),
    factId: v.string(),
  },
  handler: async (ctx, args) => {
    const fact = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();

    if (!fact) {
      throw new ConvexError("FACT_NOT_FOUND");
    }

    // Verify memorySpace owns this fact
    if (fact.memorySpaceId !== args.memorySpaceId) {
      throw new ConvexError("PERMISSION_DENIED");
    }

    await ctx.db.patch(fact._id, {
      validUntil: Date.now(),
      updatedAt: Date.now(),
    });

    return { deleted: true, factId: args.factId };
  },
});

/**
 * Delete many facts matching filters
 */
export const deleteMany = mutation({
  args: {
    memorySpaceId: v.string(),
    userId: v.optional(v.string()),
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    let facts = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    // Apply optional filters
    if (args.userId) {
      facts = facts.filter((f) => f.userId === args.userId);
    }
    if (args.factType) {
      facts = facts.filter((f) => f.factType === args.factType);
    }

    let deleted = 0;
    for (const fact of facts) {
      await ctx.db.delete(fact._id);
      deleted++;
    }

    return { deleted, memorySpaceId: args.memorySpaceId };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries (Read Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get fact by ID
 */
export const get = query({
  args: {
    memorySpaceId: v.string(),
    factId: v.string(),
  },
  handler: async (ctx, args) => {
    const fact = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();

    if (!fact) {
      return null;
    }

    // Verify memorySpace owns this fact
    if (fact.memorySpaceId !== args.memorySpaceId) {
      return null; // Permission denied (silent)
    }

    return fact;
  },
});

/**
 * List facts with filters
 */
export const list = query({
  args: {
    memorySpaceId: v.string(),
    // Fact-specific filters
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
    subject: v.optional(v.string()),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    minConfidence: v.optional(v.number()),
    confidence: v.optional(v.number()), // Exact match
    // Universal filters
    userId: v.optional(v.string()),
    participantId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    tagMatch: v.optional(v.union(v.literal("any"), v.literal("all"))),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("manual"),
      ),
    ),
    createdBefore: v.optional(v.number()),
    createdAfter: v.optional(v.number()),
    updatedBefore: v.optional(v.number()),
    updatedAfter: v.optional(v.number()),
    version: v.optional(v.number()),
    includeSuperseded: v.optional(v.boolean()),
    validAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  handler: async (ctx, args) => {
    let facts = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    // Filter out superseded by default
    if (!args.includeSuperseded) {
      facts = facts.filter((f) => f.supersededBy === undefined);
    }

    // Apply universal filters
    if (args.factType) {
      facts = facts.filter((f) => f.factType === args.factType);
    }
    if (args.subject !== undefined) {
      facts = facts.filter((f) => f.subject === args.subject);
    }
    if (args.predicate !== undefined) {
      facts = facts.filter((f) => f.predicate === args.predicate);
    }
    if (args.object !== undefined) {
      facts = facts.filter((f) => f.object === args.object);
    }
    if (args.userId !== undefined) {
      facts = facts.filter((f) => f.userId === args.userId);
    }
    if (args.participantId !== undefined) {
      facts = facts.filter((f) => f.participantId === args.participantId);
    }
    if (args.minConfidence !== undefined) {
      facts = facts.filter((f) => f.confidence >= args.minConfidence!);
    }
    if (args.confidence !== undefined) {
      facts = facts.filter((f) => f.confidence === args.confidence);
    }
    if (args.sourceType !== undefined) {
      facts = facts.filter((f) => f.sourceType === args.sourceType);
    }
    if (args.tags && args.tags.length > 0) {
      if (args.tagMatch === "all") {
        facts = facts.filter((f) =>
          args.tags!.every((tag) => f.tags.includes(tag)),
        );
      } else {
        // "any" is default
        facts = facts.filter((f) =>
          args.tags!.some((tag) => f.tags.includes(tag)),
        );
      }
    }
    if (args.createdAfter !== undefined) {
      facts = facts.filter((f) => f.createdAt >= args.createdAfter!);
    }
    if (args.createdBefore !== undefined) {
      facts = facts.filter((f) => f.createdAt <= args.createdBefore!);
    }
    if (args.updatedAfter !== undefined) {
      facts = facts.filter((f) => f.updatedAt >= args.updatedAfter!);
    }
    if (args.updatedBefore !== undefined) {
      facts = facts.filter((f) => f.updatedAt <= args.updatedBefore!);
    }
    if (args.version !== undefined) {
      facts = facts.filter((f) => f.version === args.version);
    }
    if (args.validAt !== undefined) {
      facts = facts.filter((f) => {
        const isValid =
          (!f.validFrom || f.validFrom <= args.validAt!) &&
          (!f.validUntil || f.validUntil > args.validAt!);
        return isValid;
      });
    }
    if (args.metadata !== undefined) {
      facts = facts.filter((f) => {
        if (!f.metadata) return false;
        // Match all provided metadata fields
        return Object.entries(args.metadata as Record<string, any>).every(
          ([key, value]) => f.metadata[key] === value,
        );
      });
    }

    // Apply sorting (safe - only if facts exist and sortBy is valid)
    if (args.sortBy && facts.length > 0) {
      // Validate sortBy is a valid field
      const validSortFields = [
        "createdAt",
        "updatedAt",
        "confidence",
        "version",
      ];
      if (validSortFields.includes(args.sortBy)) {
        const sortField = args.sortBy as
          | "createdAt"
          | "updatedAt"
          | "confidence"
          | "version";
        facts.sort((a, b) => {
          const aVal = a[sortField] as any;
          const bVal = b[sortField] as any;
          const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
          return args.sortOrder === "asc" ? comparison : -comparison;
        });
      }
    }

    // Apply pagination (offset and limit combined)
    const offset = args.offset || 0;
    const limit = args.limit !== undefined ? offset + args.limit : undefined;
    facts =
      limit !== undefined ? facts.slice(offset, limit) : facts.slice(offset);

    return facts;
  },
});

/**
 * Count facts
 */
export const count = query({
  args: {
    memorySpaceId: v.string(),
    // Fact-specific filters
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
    subject: v.optional(v.string()),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    minConfidence: v.optional(v.number()),
    confidence: v.optional(v.number()), // Exact match
    // Universal filters
    userId: v.optional(v.string()),
    participantId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    tagMatch: v.optional(v.union(v.literal("any"), v.literal("all"))),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("manual"),
      ),
    ),
    createdBefore: v.optional(v.number()),
    createdAfter: v.optional(v.number()),
    updatedBefore: v.optional(v.number()),
    updatedAfter: v.optional(v.number()),
    version: v.optional(v.number()),
    includeSuperseded: v.optional(v.boolean()),
    validAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    let facts = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    // Filter out superseded by default
    if (!args.includeSuperseded) {
      facts = facts.filter((f) => f.supersededBy === undefined);
    }

    // Apply universal filters (same as list)
    if (args.factType) {
      facts = facts.filter((f) => f.factType === args.factType);
    }
    if (args.subject !== undefined) {
      facts = facts.filter((f) => f.subject === args.subject);
    }
    if (args.predicate !== undefined) {
      facts = facts.filter((f) => f.predicate === args.predicate);
    }
    if (args.object !== undefined) {
      facts = facts.filter((f) => f.object === args.object);
    }
    if (args.userId !== undefined) {
      facts = facts.filter((f) => f.userId === args.userId);
    }
    if (args.participantId !== undefined) {
      facts = facts.filter((f) => f.participantId === args.participantId);
    }
    if (args.minConfidence !== undefined) {
      facts = facts.filter((f) => f.confidence >= args.minConfidence!);
    }
    if (args.confidence !== undefined) {
      facts = facts.filter((f) => f.confidence === args.confidence);
    }
    if (args.sourceType !== undefined) {
      facts = facts.filter((f) => f.sourceType === args.sourceType);
    }
    if (args.tags && args.tags.length > 0) {
      if (args.tagMatch === "all") {
        facts = facts.filter((f) =>
          args.tags!.every((tag) => f.tags.includes(tag)),
        );
      } else {
        facts = facts.filter((f) =>
          args.tags!.some((tag) => f.tags.includes(tag)),
        );
      }
    }
    if (args.createdAfter !== undefined) {
      facts = facts.filter((f) => f.createdAt >= args.createdAfter!);
    }
    if (args.createdBefore !== undefined) {
      facts = facts.filter((f) => f.createdAt <= args.createdBefore!);
    }
    if (args.updatedAfter !== undefined) {
      facts = facts.filter((f) => f.updatedAt >= args.updatedAfter!);
    }
    if (args.updatedBefore !== undefined) {
      facts = facts.filter((f) => f.updatedAt <= args.updatedBefore!);
    }
    if (args.version !== undefined) {
      facts = facts.filter((f) => f.version === args.version);
    }
    if (args.validAt !== undefined) {
      facts = facts.filter((f) => {
        const isValid =
          (!f.validFrom || f.validFrom <= args.validAt!) &&
          (!f.validUntil || f.validUntil > args.validAt!);
        return isValid;
      });
    }
    if (args.metadata !== undefined) {
      facts = facts.filter((f) => {
        if (!f.metadata) return false;
        return Object.entries(args.metadata as Record<string, any>).every(
          ([key, value]) => f.metadata[key] === value,
        );
      });
    }

    return facts.length;
  },
});

/**
 * Search facts by content
 */
export const search = query({
  args: {
    memorySpaceId: v.string(),
    query: v.string(),
    // Fact-specific filters
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
    subject: v.optional(v.string()),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    minConfidence: v.optional(v.number()),
    confidence: v.optional(v.number()), // Exact match
    // Universal filters
    userId: v.optional(v.string()),
    participantId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    tagMatch: v.optional(v.union(v.literal("any"), v.literal("all"))),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("manual"),
      ),
    ),
    createdBefore: v.optional(v.number()),
    createdAfter: v.optional(v.number()),
    updatedBefore: v.optional(v.number()),
    updatedAfter: v.optional(v.number()),
    version: v.optional(v.number()),
    includeSuperseded: v.optional(v.boolean()),
    validAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  handler: async (ctx, args) => {
    // Keyword search on fact content
    const results = await ctx.db
      .query("facts")
      .withSearchIndex("by_content", (q) =>
        q.search("fact", args.query).eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    // Filter superseded unless explicitly requested
    let filtered = args.includeSuperseded
      ? results
      : results.filter((f) => f.supersededBy === undefined);

    // Apply universal filters (same as list/count)
    if (args.factType) {
      filtered = filtered.filter((f) => f.factType === args.factType);
    }
    if (args.subject !== undefined) {
      filtered = filtered.filter((f) => f.subject === args.subject);
    }
    if (args.predicate !== undefined) {
      filtered = filtered.filter((f) => f.predicate === args.predicate);
    }
    if (args.object !== undefined) {
      filtered = filtered.filter((f) => f.object === args.object);
    }
    if (args.userId !== undefined) {
      filtered = filtered.filter((f) => f.userId === args.userId);
    }
    if (args.participantId !== undefined) {
      filtered = filtered.filter((f) => f.participantId === args.participantId);
    }
    if (args.minConfidence !== undefined) {
      filtered = filtered.filter((f) => f.confidence >= args.minConfidence!);
    }
    if (args.confidence !== undefined) {
      filtered = filtered.filter((f) => f.confidence === args.confidence);
    }
    if (args.sourceType !== undefined) {
      filtered = filtered.filter((f) => f.sourceType === args.sourceType);
    }
    if (args.tags && args.tags.length > 0) {
      if (args.tagMatch === "all") {
        filtered = filtered.filter((f) =>
          args.tags!.every((tag) => f.tags.includes(tag)),
        );
      } else {
        filtered = filtered.filter((f) =>
          args.tags!.some((tag) => f.tags.includes(tag)),
        );
      }
    }
    if (args.createdAfter !== undefined) {
      filtered = filtered.filter((f) => f.createdAt >= args.createdAfter!);
    }
    if (args.createdBefore !== undefined) {
      filtered = filtered.filter((f) => f.createdAt <= args.createdBefore!);
    }
    if (args.updatedAfter !== undefined) {
      filtered = filtered.filter((f) => f.updatedAt >= args.updatedAfter!);
    }
    if (args.updatedBefore !== undefined) {
      filtered = filtered.filter((f) => f.updatedAt <= args.updatedBefore!);
    }
    if (args.version !== undefined) {
      filtered = filtered.filter((f) => f.version === args.version);
    }
    if (args.validAt !== undefined) {
      filtered = filtered.filter((f) => {
        const isValid =
          (!f.validFrom || f.validFrom <= args.validAt!) &&
          (!f.validUntil || f.validUntil > args.validAt!);
        return isValid;
      });
    }
    if (args.metadata !== undefined) {
      filtered = filtered.filter((f) => {
        if (!f.metadata) return false;
        return Object.entries(args.metadata as Record<string, any>).every(
          ([key, value]) => f.metadata[key] === value,
        );
      });
    }

    // Apply sorting (safe - only if facts exist and sortBy is valid)
    if (args.sortBy && filtered.length > 0) {
      // Validate sortBy is a valid field
      const validSortFields = [
        "createdAt",
        "updatedAt",
        "confidence",
        "version",
      ];
      if (validSortFields.includes(args.sortBy)) {
        const sortField = args.sortBy as
          | "createdAt"
          | "updatedAt"
          | "confidence"
          | "version";
        filtered.sort((a, b) => {
          const aVal = a[sortField] as any;
          const bVal = b[sortField] as any;
          const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
          return args.sortOrder === "asc" ? comparison : -comparison;
        });
      }
    }

    // Apply pagination (offset and limit combined)
    const offset = args.offset || 0;
    const limit = args.limit !== undefined ? offset + args.limit : undefined;
    filtered =
      limit !== undefined
        ? filtered.slice(offset, limit)
        : filtered.slice(offset);

    return filtered;
  },
});

/**
 * Get fact version history
 */
export const getHistory = query({
  args: {
    memorySpaceId: v.string(),
    factId: v.string(),
  },
  handler: async (ctx, args) => {
    const fact = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.factId))
      .first();

    if (!fact || fact.memorySpaceId !== args.memorySpaceId) {
      return [];
    }

    // Build version chain - start from given fact and go both directions
    const history: any[] = [];

    // First, go backward to find oldest version
    let oldest = fact;
    while (oldest.supersedes) {
      const previous = await ctx.db
        .query("facts")
        .withIndex("by_factId", (q) => q.eq("factId", oldest.supersedes!))
        .first();

      if (previous) {
        oldest = previous;
      } else {
        break;
      }
    }

    // Now go forward from oldest to build complete chain
    history.push(oldest);
    let current = oldest;

    while (current.supersededBy) {
      const next = await ctx.db
        .query("facts")
        .withIndex("by_factId", (q) => q.eq("factId", current.supersededBy!))
        .first();

      if (next) {
        history.push(next);
        current = next;
      } else {
        break;
      }
    }

    return history; // Already in chronological order
  },
});

/**
 * Query facts by subject (entity-centric)
 */
export const queryBySubject = query({
  args: {
    memorySpaceId: v.string(),
    subject: v.string(),
    // Fact-specific filters
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    minConfidence: v.optional(v.number()),
    confidence: v.optional(v.number()), // Exact match
    // Universal filters
    userId: v.optional(v.string()),
    participantId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    tagMatch: v.optional(v.union(v.literal("any"), v.literal("all"))),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("manual"),
      ),
    ),
    createdBefore: v.optional(v.number()),
    createdAfter: v.optional(v.number()),
    updatedBefore: v.optional(v.number()),
    updatedAfter: v.optional(v.number()),
    version: v.optional(v.number()),
    includeSuperseded: v.optional(v.boolean()),
    validAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  handler: async (ctx, args) => {
    let facts = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace_subject", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId).eq("subject", args.subject),
      )
      .collect();

    // Filter superseded (unless explicitly requested)
    if (!args.includeSuperseded) {
      facts = facts.filter((f) => f.supersededBy === undefined);
    }

    // Apply universal filters
    if (args.factType) {
      facts = facts.filter((f) => f.factType === args.factType);
    }
    if (args.userId !== undefined) {
      facts = facts.filter((f) => f.userId === args.userId);
    }
    if (args.participantId !== undefined) {
      facts = facts.filter((f) => f.participantId === args.participantId);
    }
    if (args.predicate !== undefined) {
      facts = facts.filter((f) => f.predicate === args.predicate);
    }
    if (args.object !== undefined) {
      facts = facts.filter((f) => f.object === args.object);
    }
    if (args.minConfidence !== undefined) {
      facts = facts.filter((f) => f.confidence >= args.minConfidence!);
    }
    if (args.confidence !== undefined) {
      facts = facts.filter((f) => f.confidence === args.confidence);
    }
    if (args.sourceType !== undefined) {
      facts = facts.filter((f) => f.sourceType === args.sourceType);
    }
    if (args.tags && args.tags.length > 0) {
      if (args.tagMatch === "all") {
        facts = facts.filter((f) =>
          args.tags!.every((tag) => f.tags.includes(tag)),
        );
      } else {
        // "any" is default
        facts = facts.filter((f) =>
          args.tags!.some((tag) => f.tags.includes(tag)),
        );
      }
    }
    if (args.createdAfter !== undefined) {
      facts = facts.filter((f) => f.createdAt >= args.createdAfter!);
    }
    if (args.createdBefore !== undefined) {
      facts = facts.filter((f) => f.createdAt <= args.createdBefore!);
    }
    if (args.updatedAfter !== undefined) {
      facts = facts.filter((f) => f.updatedAt >= args.updatedAfter!);
    }
    if (args.updatedBefore !== undefined) {
      facts = facts.filter((f) => f.updatedAt <= args.updatedBefore!);
    }
    if (args.version !== undefined) {
      facts = facts.filter((f) => f.version === args.version);
    }
    if (args.validAt !== undefined) {
      facts = facts.filter((f) => {
        const isValid =
          (!f.validFrom || f.validFrom <= args.validAt!) &&
          (!f.validUntil || f.validUntil > args.validAt!);
        return isValid;
      });
    }
    if (args.metadata !== undefined) {
      facts = facts.filter((f) => {
        if (!f.metadata) return false;
        // Match all provided metadata fields
        return Object.entries(args.metadata as Record<string, any>).every(
          ([key, value]) => f.metadata[key] === value,
        );
      });
    }

    // Apply sorting (safe - only if facts exist and sortBy is valid)
    if (args.sortBy && facts.length > 0) {
      // Validate sortBy is a valid field
      const validSortFields = [
        "createdAt",
        "updatedAt",
        "confidence",
        "version",
      ];
      if (validSortFields.includes(args.sortBy)) {
        const sortField = args.sortBy as
          | "createdAt"
          | "updatedAt"
          | "confidence"
          | "version";
        facts.sort((a, b) => {
          const aVal = a[sortField] as any;
          const bVal = b[sortField] as any;
          const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
          return args.sortOrder === "asc" ? comparison : -comparison;
        });
      }
    }

    // Apply pagination (offset and limit combined)
    const offset = args.offset || 0;
    const limit = args.limit !== undefined ? offset + args.limit : undefined;
    facts =
      limit !== undefined ? facts.slice(offset, limit) : facts.slice(offset);

    return facts;
  },
});

/**
 * Query facts by relationship (graph traversal)
 */
export const queryByRelationship = query({
  args: {
    memorySpaceId: v.string(),
    subject: v.string(),
    predicate: v.string(),
    // Fact-specific filters
    object: v.optional(v.string()),
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
    minConfidence: v.optional(v.number()),
    confidence: v.optional(v.number()), // Exact match
    // Universal filters
    userId: v.optional(v.string()),
    participantId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    tagMatch: v.optional(v.union(v.literal("any"), v.literal("all"))),
    sourceType: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("system"),
        v.literal("tool"),
        v.literal("manual"),
      ),
    ),
    createdBefore: v.optional(v.number()),
    createdAfter: v.optional(v.number()),
    updatedBefore: v.optional(v.number()),
    updatedAfter: v.optional(v.number()),
    version: v.optional(v.number()),
    includeSuperseded: v.optional(v.boolean()),
    validAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  handler: async (ctx, args) => {
    let facts = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace_subject", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId).eq("subject", args.subject),
      )
      .collect();

    // Filter by predicate and superseded
    facts = facts.filter((f) => f.predicate === args.predicate);
    if (!args.includeSuperseded) {
      facts = facts.filter((f) => f.supersededBy === undefined);
    }

    // Apply universal filters
    if (args.object !== undefined) {
      facts = facts.filter((f) => f.object === args.object);
    }
    if (args.factType) {
      facts = facts.filter((f) => f.factType === args.factType);
    }
    if (args.userId !== undefined) {
      facts = facts.filter((f) => f.userId === args.userId);
    }
    if (args.participantId !== undefined) {
      facts = facts.filter((f) => f.participantId === args.participantId);
    }
    if (args.minConfidence !== undefined) {
      facts = facts.filter((f) => f.confidence >= args.minConfidence!);
    }
    if (args.confidence !== undefined) {
      facts = facts.filter((f) => f.confidence === args.confidence);
    }
    if (args.sourceType !== undefined) {
      facts = facts.filter((f) => f.sourceType === args.sourceType);
    }
    if (args.tags && args.tags.length > 0) {
      if (args.tagMatch === "all") {
        facts = facts.filter((f) =>
          args.tags!.every((tag) => f.tags.includes(tag)),
        );
      } else {
        facts = facts.filter((f) =>
          args.tags!.some((tag) => f.tags.includes(tag)),
        );
      }
    }
    if (args.createdAfter !== undefined) {
      facts = facts.filter((f) => f.createdAt >= args.createdAfter!);
    }
    if (args.createdBefore !== undefined) {
      facts = facts.filter((f) => f.createdAt <= args.createdBefore!);
    }
    if (args.updatedAfter !== undefined) {
      facts = facts.filter((f) => f.updatedAt >= args.updatedAfter!);
    }
    if (args.updatedBefore !== undefined) {
      facts = facts.filter((f) => f.updatedAt <= args.updatedBefore!);
    }
    if (args.version !== undefined) {
      facts = facts.filter((f) => f.version === args.version);
    }
    if (args.validAt !== undefined) {
      facts = facts.filter((f) => {
        const isValid =
          (!f.validFrom || f.validFrom <= args.validAt!) &&
          (!f.validUntil || f.validUntil > args.validAt!);
        return isValid;
      });
    }
    if (args.metadata !== undefined) {
      facts = facts.filter((f) => {
        if (!f.metadata) return false;
        // Match all provided metadata fields
        return Object.entries(args.metadata as Record<string, any>).every(
          ([key, value]) => f.metadata[key] === value,
        );
      });
    }

    // Apply sorting (safe - only if facts exist and sortBy is valid)
    if (args.sortBy && facts.length > 0) {
      // Validate sortBy is a valid field
      const validSortFields = [
        "createdAt",
        "updatedAt",
        "confidence",
        "version",
      ];
      if (validSortFields.includes(args.sortBy)) {
        const sortField = args.sortBy as
          | "createdAt"
          | "updatedAt"
          | "confidence"
          | "version";
        facts.sort((a, b) => {
          const aVal = a[sortField] as any;
          const bVal = b[sortField] as any;
          const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
          return args.sortOrder === "asc" ? comparison : -comparison;
        });
      }
    }

    // Apply pagination (offset and limit combined)
    const offset = args.offset || 0;
    const limit = args.limit !== undefined ? offset + args.limit : undefined;
    facts =
      limit !== undefined ? facts.slice(offset, limit) : facts.slice(offset);

    return facts;
  },
});

/**
 * Export facts
 */
export const exportFacts = query({
  args: {
    memorySpaceId: v.string(),
    format: v.union(v.literal("json"), v.literal("jsonld"), v.literal("csv")),
    factType: v.optional(
      v.union(
        v.literal("preference"),
        v.literal("identity"),
        v.literal("knowledge"),
        v.literal("relationship"),
        v.literal("event"),
        v.literal("observation"),
        v.literal("custom"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    let facts = await ctx.db
      .query("facts")
      .withIndex("by_memorySpace", (q) =>
        q.eq("memorySpaceId", args.memorySpaceId),
      )
      .collect();

    // Filter superseded
    facts = facts.filter((f) => f.supersededBy === undefined);

    if (args.factType) {
      facts = facts.filter((f) => f.factType === args.factType);
    }

    const exportedAt = Date.now();

    if (args.format === "json") {
      return {
        format: "json",
        data: JSON.stringify(facts, null, 2),
        count: facts.length,
        exportedAt,
      };
    }

    if (args.format === "jsonld") {
      // JSON-LD format for semantic web
      const jsonld = {
        "@context": "https://schema.org/",
        "@graph": facts.map((f) => ({
          "@type": "Fact",
          "@id": f.factId,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          factStatement: f.fact,
          confidence: f.confidence,
          factType: f.factType,
          dateCreated: new Date(f.createdAt).toISOString(),
          validFrom: f.validFrom
            ? new Date(f.validFrom).toISOString()
            : undefined,
          validThrough: f.validUntil
            ? new Date(f.validUntil).toISOString()
            : undefined,
        })),
      };

      return {
        format: "jsonld",
        data: JSON.stringify(jsonld, null, 2),
        count: facts.length,
        exportedAt,
      };
    }

    // CSV format
    const headers = [
      "factId",
      "fact",
      "factType",
      "subject",
      "predicate",
      "object",
      "confidence",
      "sourceType",
      "tags",
      "createdAt",
    ];
    const rows = facts.map((f) => [
      f.factId,
      `"${f.fact.replace(/"/g, '""')}"`, // Escape quotes
      f.factType,
      f.subject || "",
      f.predicate || "",
      f.object || "",
      f.confidence.toString(),
      f.sourceType,
      f.tags.join(";"),
      new Date(f.createdAt).toISOString(),
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    return {
      format: "csv",
      data: csv,
      count: facts.length,
      exportedAt,
    };
  },
});

/**
 * Consolidate duplicate facts
 */
export const consolidate = mutation({
  args: {
    memorySpaceId: v.string(),
    factIds: v.array(v.string()), // Facts to merge
    keepFactId: v.string(), // Fact to keep
  },
  handler: async (ctx, args) => {
    if (!args.factIds.includes(args.keepFactId)) {
      throw new Error("KEEP_FACT_NOT_IN_LIST");
    }

    const now = Date.now();

    // Mark all others as superseded by the kept fact
    for (const factId of args.factIds) {
      if (factId === args.keepFactId) continue;

      const fact = await ctx.db
        .query("facts")
        .withIndex("by_factId", (q) => q.eq("factId", factId))
        .first();

      if (fact && fact.memorySpaceId === args.memorySpaceId) {
        await ctx.db.patch(fact._id, {
          supersededBy: args.keepFactId,
          validUntil: now,
        });
      }
    }

    // Update confidence of kept fact (average of all)
    const kept = await ctx.db
      .query("facts")
      .withIndex("by_factId", (q) => q.eq("factId", args.keepFactId))
      .first();

    if (kept && kept.memorySpaceId === args.memorySpaceId) {
      const allFacts = await Promise.all(
        args.factIds.map((id) =>
          ctx.db
            .query("facts")
            .withIndex("by_factId", (q) => q.eq("factId", id))
            .first(),
        ),
      );

      const validFacts = allFacts.filter((f) => f !== null) as any[];
      const avgConfidence =
        validFacts.reduce((sum, f) => sum + f.confidence, 0) /
        validFacts.length;

      await ctx.db.patch(kept._id, {
        confidence: Math.round(avgConfidence),
        updatedAt: now,
      });
    }

    return {
      consolidated: true,
      keptFactId: args.keepFactId,
      mergedCount: args.factIds.length - 1,
    };
  },
});

/**
 * Delete multiple facts by their IDs (batch delete for cascade operations)
 * Much faster than calling deleteFact multiple times
 * Uses index lookups instead of full table scan to avoid memory issues with large tables
 */
export const deleteByIds = mutation({
  args: {
    factIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const deletedIds: string[] = [];
    const now = Date.now();

    // Look up each fact by index to avoid full table scan
    // This is O(n) index lookups vs O(entire table) memory usage
    for (const factId of args.factIds) {
      const fact = await ctx.db
        .query("facts")
        .withIndex("by_factId", (q) => q.eq("factId", factId))
        .first();

      if (fact) {
        // Soft delete by marking as invalidated
        await ctx.db.patch(fact._id, {
          validUntil: now,
          updatedAt: now,
        });
        deletedIds.push(factId);
      }
    }

    return {
      deleted: deletedIds.length,
      factIds: deletedIds,
    };
  },
});

/**
 * Purge all facts (TEST/DEV ONLY)
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

    const allFacts = await ctx.db.query("facts").collect();

    for (const fact of allFacts) {
      await ctx.db.delete(fact._id);
    }

    return { deleted: allFacts.length };
  },
});
