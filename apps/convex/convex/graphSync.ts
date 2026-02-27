/**
 * Graph Sync Queue
 *
 * Manages the queue for syncing Cortex entities to graph database.
 * Uses Convex reactive queries for real-time synchronization.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutations (Write Operations)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Queue an entity for graph synchronization
 *
 * Called automatically when syncToGraph: true option is used
 */
export const queueForSync = mutation({
  args: {
    table: v.string(), // "memories", "facts", "contexts", etc.
    entityId: v.string(), // Cortex entity ID
    operation: v.union(
      v.literal("insert"),
      v.literal("update"),
      v.literal("delete"),
    ),
    entity: v.optional(v.any()), // Full entity data (null for deletes)
    priority: v.optional(v.string()), // "high", "normal", "low"
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if already queued (avoid duplicates)
    const existing = await ctx.db
      .query("graphSyncQueue")
      .withIndex("by_table_entity", (q) =>
        q.eq("table", args.table).eq("entityId", args.entityId),
      )
      .filter((q) => q.eq(q.field("synced"), false))
      .first();

    if (existing) {
      // Update existing queue item
      await ctx.db.patch(existing._id, {
        operation: args.operation,
        entity: args.entity,
        priority: args.priority || "normal",
        createdAt: now, // Update timestamp
      });

      return existing._id;
    }

    // Create new queue item
    const queueItemId = await ctx.db.insert("graphSyncQueue", {
      table: args.table,
      entityId: args.entityId,
      operation: args.operation,
      entity: args.entity,
      synced: false,
      failedAttempts: 0,
      priority: args.priority || "normal",
      createdAt: now,
    });

    return queueItemId;
  },
});

/**
 * Mark an item as successfully synced
 */
export const markSynced = mutation({
  args: {
    id: v.id("graphSyncQueue"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      synced: true,
      syncedAt: Date.now(),
      lastError: undefined,
    });
  },
});

/**
 * Mark an item as failed (for retry)
 */
export const markFailed = mutation({
  args: {
    id: v.id("graphSyncQueue"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);

    if (!item) {
      throw new Error("SYNC_ITEM_NOT_FOUND");
    }

    const failedAttempts = (item.failedAttempts || 0) + 1;
    const maxAttempts = 3;

    await ctx.db.patch(args.id, {
      failedAttempts,
      lastError: args.error,
      // Mark as synced if max attempts reached (give up)
      synced: failedAttempts >= maxAttempts,
      syncedAt: failedAttempts >= maxAttempts ? Date.now() : undefined,
    });
  },
});

/**
 * Delete a sync queue item
 */
export const deleteSyncItem = mutation({
  args: {
    id: v.id("graphSyncQueue"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Queries (Read Operations - REACTIVE)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get unsynced items (REACTIVE QUERY)
 *
 * This query is used by GraphSyncWorker with client.onUpdate()
 * It automatically fires when new items are added to the queue!
 */
export const getUnsyncedItems = query({
  args: {
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("graphSyncQueue")
      .withIndex("by_synced", (q) => q.eq("synced", false))
      .order("desc") // Newest first
      .take(args.limit);
  },
});

/**
 * Get high-priority unsynced items
 */
export const getHighPriorityItems = query({
  args: {
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("graphSyncQueue")
      .withIndex("by_priority", (q) =>
        q.eq("priority", "high").eq("synced", false),
      )
      .order("desc")
      .take(args.limit);
  },
});

/**
 * Get sync queue statistics
 */
export const getSyncStats = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("graphSyncQueue").collect();

    const unsynced = all.filter((item) => !item.synced);
    const synced = all.filter((item) => item.synced);
    const failed = all.filter((item) => (item.failedAttempts || 0) > 0);

    // Calculate average sync time
    const syncedItems = all.filter((item) => item.syncedAt && item.createdAt);
    const avgSyncTime =
      syncedItems.length > 0
        ? syncedItems.reduce(
            (sum, item) => sum + (item.syncedAt! - item.createdAt),
            0,
          ) / syncedItems.length
        : 0;

    // Calculate sync lag (oldest unsynced item)
    const oldestUnsynced = unsynced.reduce(
      (oldest, item) =>
        !oldest || item.createdAt < oldest.createdAt ? item : oldest,
      null as any,
    );

    const syncLag = oldestUnsynced ? Date.now() - oldestUnsynced.createdAt : 0;

    return {
      total: all.length,
      unsynced: unsynced.length,
      synced: synced.length,
      failed: failed.length,
      avgSyncTimeMs: Math.round(avgSyncTime),
      syncLagMs: syncLag,
      byTable: all.reduce(
        (acc, item) => {
          acc[item.table] = (acc[item.table] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    };
  },
});

/**
 * Get failed sync items for debugging
 */
export const getFailedItems = query({
  args: {
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const items = await ctx.db.query("graphSyncQueue").collect();

    return items
      .filter((item) => (item.failedAttempts || 0) > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, args.limit);
  },
});

/**
 * Clear all synced items (cleanup)
 */
export const clearSyncedItems = mutation({
  args: {
    olderThanMs: v.optional(v.number()), // Clear items synced more than X ms ago
  },
  handler: async (ctx, args) => {
    const cutoff = args.olderThanMs
      ? Date.now() - args.olderThanMs
      : Date.now() - 24 * 60 * 60 * 1000; // Default: 24 hours

    const items = await ctx.db
      .query("graphSyncQueue")
      .filter((q) =>
        q.and(q.eq(q.field("synced"), true), q.lt(q.field("syncedAt"), cutoff)),
      )
      .collect();

    for (const item of items) {
      await ctx.db.delete(item._id);
    }

    return { deleted: items.length };
  },
});

/**
 * Purge all graph sync queue items (TEST/DEV ONLY)
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

    const allItems = await ctx.db.query("graphSyncQueue").collect();

    for (const item of allItems) {
      await ctx.db.delete(item._id);
    }

    return { deleted: allItems.length };
  },
});
