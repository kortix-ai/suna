/**
 * Cortex Convex Functions - Users API
 *
 * Backend functions for user profile management.
 * Most operations delegate to immutable store with type='user'.
 * Cascade deletion is orchestrated in the SDK layer.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get user profile
 * Delegates to immutable.get with type='user'
 */
export const get = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("immutable")
      .withIndex("by_type_id", (q) =>
        q.eq("type", "user").eq("id", args.userId),
      )
      .first();

    if (!entry) {
      return null;
    }

    return {
      id: entry.id,
      data: entry.data,
      version: entry.version,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  },
});

/**
 * List user profiles
 * Delegates to immutable.list with type='user'
 */
export const list = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const query = ctx.db
      .query("immutable")
      .withIndex("by_type", (q) => q.eq("type", "user"));

    const entries = args.limit
      ? await query.take(args.limit)
      : await query.collect();

    return entries.map((entry) => ({
      id: entry.id,
      data: entry.data,
      version: entry.version,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
  },
});

/**
 * Count user profiles
 * Delegates to immutable.count with type='user'
 */
export const count = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db
      .query("immutable")
      .withIndex("by_type", (q) => q.eq("type", "user"))
      .collect();

    return entries.length;
  },
});

/**
 * Get specific version of user profile
 * Delegates to immutable.getVersion with type='user'
 */
export const getVersion = query({
  args: {
    userId: v.string(),
    version: v.number(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("immutable")
      .withIndex("by_type_id", (q) =>
        q.eq("type", "user").eq("id", args.userId),
      )
      .first();

    if (!entry) {
      return null;
    }

    // Check current version
    if (entry.version === args.version) {
      return {
        version: entry.version,
        data: entry.data,
        timestamp: entry.updatedAt,
      };
    }

    // Check previous versions
    const previousVersion = entry.previousVersions.find(
      (v) => v.version === args.version,
    );

    if (!previousVersion) {
      return null;
    }

    return {
      version: previousVersion.version,
      data: previousVersion.data,
      timestamp: previousVersion.timestamp,
    };
  },
});

/**
 * Get version history of user profile
 * Delegates to immutable.getHistory with type='user'
 */
export const getHistory = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("immutable")
      .withIndex("by_type_id", (q) =>
        q.eq("type", "user").eq("id", args.userId),
      )
      .first();

    if (!entry) {
      return [];
    }

    // Include current version + all previous versions
    const history = [
      {
        version: entry.version,
        data: entry.data,
        timestamp: entry.updatedAt,
      },
      ...entry.previousVersions.map((v) => ({
        version: v.version,
        data: v.data,
        timestamp: v.timestamp,
      })),
    ];

    // Sort by version descending (newest first)
    return history.sort((a, b) => b.version - a.version);
  },
});

/**
 * Get user profile at specific timestamp
 * Delegates to immutable.getAtTimestamp with type='user'
 */
export const getAtTimestamp = query({
  args: {
    userId: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("immutable")
      .withIndex("by_type_id", (q) =>
        q.eq("type", "user").eq("id", args.userId),
      )
      .first();

    if (!entry) {
      return null;
    }

    // If entry was created after timestamp, no version exists
    if (entry.createdAt > args.timestamp) {
      return null;
    }

    // If current version was updated before or at timestamp, return it
    if (entry.updatedAt <= args.timestamp) {
      return {
        version: entry.version,
        data: entry.data,
        timestamp: entry.updatedAt,
      };
    }

    // Find latest version before timestamp in previous versions
    const previousVersions = entry.previousVersions
      .filter((v) => v.timestamp <= args.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (previousVersions.length === 0) {
      return null;
    }

    const version = previousVersions[0];
    return {
      version: version.version,
      data: version.data,
      timestamp: version.timestamp,
    };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutation Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Create or update user profile
 * Delegates to immutable.store with type='user'
 *
 * Note: This is handled by the SDK via immutable.store mutation.
 * No separate users.update mutation needed as it delegates directly.
 */

/**
 * Delete user profile (simple deletion, no cascade)
 * Delegates to immutable.purge with type='user'
 *
 * Note: Cascade deletion is orchestrated in the SDK layer by calling
 * individual delete mutations for each layer (conversations, vector, etc.).
 * This mutation only deletes the user profile itself.
 */
export const deleteUserProfile = mutation({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("immutable")
      .withIndex("by_type_id", (q) =>
        q.eq("type", "user").eq("id", args.userId),
      )
      .first();

    if (!entry) {
      return { deleted: false };
    }

    await ctx.db.delete(entry._id);

    return { deleted: true };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helper Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Check if user exists
 */
export const exists = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("immutable")
      .withIndex("by_type_id", (q) =>
        q.eq("type", "user").eq("id", args.userId),
      )
      .first();

    return entry !== null;
  },
});

/**
 * Note: Cascade deletion is NOT implemented as a single backend mutation.
 *
 * Instead, the SDK orchestrates cascade deletion by:
 * 1. Collecting all records to delete (conversations, immutable, mutable, vector, facts, graph)
 * 2. Backing up records for rollback
 * 3. Calling individual delete mutations for each layer in reverse dependency order
 * 4. Verifying deletion completeness
 * 5. Rolling back if any step fails
 *
 * This approach provides better control, error handling, and rollback capabilities
 * than a single complex backend mutation.
 *
 * The SDK can call these existing mutations:
 * - api.conversations.delete
 * - api.immutable.purge
 * - api.mutable.delete
 * - api.vector.delete
 * - api.facts.delete
 * - graphAdapter.deleteNode (if configured)
 *
 * This architecture also works for both free SDK (with DIY graph) and
 * Cloud Mode (with managed graph), following our "same code, different context" principle.
 */
