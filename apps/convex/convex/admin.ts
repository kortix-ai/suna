/**
 * Admin Operations
 *
 * Low-level administrative functions for database management.
 * These bypass normal validation for cleanup/maintenance operations.
 *
 * WARNING: These functions are powerful and should only be used by
 * authorized administrative tools like the CLI.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Generic List All Functions (for db clear)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * List all records from any table
 */
export const listTable = query({
  args: {
    table: v.union(
      v.literal("agents"),
      v.literal("contexts"),
      v.literal("conversations"),
      v.literal("facts"),
      v.literal("governanceEnforcement"),
      v.literal("governancePolicies"),
      v.literal("graphSyncQueue"),
      v.literal("immutable"),
      v.literal("memories"),
      v.literal("memorySpaces"),
      v.literal("mutable"),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 1000, 1000);

    // Query the specified table dynamically
    // The table name is validated by the union type in args
    // Note: We can't use .order() on dynamic queries without an indexed context.
    // Using .take() without ordering returns records in insertion order.
    const records = await ctx.db.query(args.table).take(limit);

    return records;
  },
});

/**
 * Delete a record by its Convex _id
 */
export const deleteRecord = mutation({
  args: {
    table: v.union(
      v.literal("agents"),
      v.literal("contexts"),
      v.literal("conversations"),
      v.literal("facts"),
      v.literal("governanceEnforcement"),
      v.literal("governancePolicies"),
      v.literal("graphSyncQueue"),
      v.literal("immutable"),
      v.literal("memories"),
      v.literal("memorySpaces"),
      v.literal("mutable"),
    ),
    // Accept any valid Convex ID - table routing is handled by the ID itself
    id: v.union(
      v.id("agents"),
      v.id("contexts"),
      v.id("conversations"),
      v.id("facts"),
      v.id("governanceEnforcement"),
      v.id("governancePolicies"),
      v.id("graphSyncQueue"),
      v.id("immutable"),
      v.id("memories"),
      v.id("memorySpaces"),
      v.id("mutable"),
    ),
  },
  handler: async (ctx, args) => {
    // Delete the record directly using Convex _id
    // Convex routes to the correct table based on the ID prefix
    await ctx.db.delete(args.id);
    return { deleted: true };
  },
});

/**
 * Bulk delete all records from a table (up to limit)
 * Returns count of deleted records
 */
export const clearTable = mutation({
  args: {
    table: v.union(
      v.literal("agents"),
      v.literal("contexts"),
      v.literal("conversations"),
      v.literal("facts"),
      v.literal("governanceEnforcement"),
      v.literal("governancePolicies"),
      v.literal("graphSyncQueue"),
      v.literal("immutable"),
      v.literal("memories"),
      v.literal("memorySpaces"),
      v.literal("mutable"),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 1000, 1000);

    // Query the specified table dynamically
    // The table name is validated by the union type in args
    // Note: We can't use .order() on dynamic queries without an indexed context.
    // Using .take() without ordering returns records in insertion order.
    const records = await ctx.db.query(args.table).take(limit);

    let deleted = 0;
    for (const record of records) {
      await ctx.db.delete(record._id);
      deleted++;
    }

    return {
      deleted,
      hasMore: records.length === limit,
    };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Table Statistics
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Count records in a table
 */
export const countTable = query({
  args: {
    table: v.union(
      v.literal("agents"),
      v.literal("contexts"),
      v.literal("conversations"),
      v.literal("facts"),
      v.literal("governanceEnforcement"),
      v.literal("governancePolicies"),
      v.literal("graphSyncQueue"),
      v.literal("immutable"),
      v.literal("memories"),
      v.literal("memorySpaces"),
      v.literal("mutable"),
    ),
  },
  handler: async (ctx, args) => {
    // Count by fetching all (limited to reasonable amount for performance)
    // Query the specified table dynamically
    const records = await ctx.db.query(args.table).take(10000);

    return { count: records.length };
  },
});

/**
 * Get counts for all tables at once
 */
export const getAllCounts = query({
  args: {},
  handler: async (ctx) => {
    const tables = [
      "agents",
      "contexts",
      "conversations",
      "facts",
      "governanceEnforcement",
      "governancePolicies",
      "graphSyncQueue",
      "immutable",
      "memories",
      "memorySpaces",
      "mutable",
    ] as const;

    const counts: Record<string, number> = {};

    for (const table of tables) {
      const records = await ctx.db.query(table).take(10000);
      counts[table] = records.length;
    }

    return counts;
  },
});
