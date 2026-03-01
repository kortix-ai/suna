/**
 * Kortix Suna - Better Auth Convex Functions
 *
 * This module exports Better Auth functions for the Convex adapter.
 * It wraps the @convex-dev/better-auth package with Suna-specific
 * configuration and additional helper functions.
 *
 * Features:
 * - Email/password authentication
 * - OAuth (GitHub, Google)
 * - Session management
 * - API key authentication for Python backend
 * - CSRF protection
 */

import { query, mutation, action } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";

import { ConvexError } from "convex/values";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  image?: string;
  emailVerified: boolean;
  tier?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  trialEndsAt?: number;
  preferences?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
  csrfToken?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AuthError {
  code: string;
  message: string;
  status: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get current session
 * Validates session token and returns user data
 */
export const getSession = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args): Promise<AuthSession | null> => {
    // Use filter instead of reserved by_id index
    const session = await ctx.db
      .query("sessions")
      .filter((q) => q.eq(q.field("id"), args.sessionToken))
      .first();

    if (!session) {
      return null;
    }

    // Check expiration
    if (session.expiresAt < Date.now()) {
      return null;
    }

    return {
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      csrfToken: session.csrfToken,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  },
});

/**
 * Get user by session token
 */
export const getUserBySession = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args): Promise<AuthUser | null> => {
    const session = await ctx.db
      .query("sessions")
      .filter((q) => q.eq(q.field("id"), args.sessionToken))
      .first();

    if (!session || session.expiresAt < Date.now()) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("id"), session.userId))
      .first();

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified,
      tier: user.tier,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
      trialEndsAt: user.trialEndsAt,
      preferences: user.preferences,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  },
});

/**
 * Create session (internal - called by Better Auth adapter)
 */
export const createSession = mutation({
  args: {
    id: v.string(),
    userId: v.string(),
    expiresAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    csrfToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AuthSession> => {
    const now = Date.now();

    await ctx.db.insert("sessions", {
      id: args.id,
      userId: args.userId,
      expiresAt: args.expiresAt,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      csrfToken: args.csrfToken,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: args.id,
      userId: args.userId,
      expiresAt: args.expiresAt,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      csrfToken: args.csrfToken,
      createdAt: now,
      updatedAt: now,
    };
  },
});

/**
 * Delete session (sign out)
 */
export const deleteSession = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const session = await ctx.db
      .query("sessions")
      .filter((q) => q.eq(q.field("id"), args.sessionToken))
      .first();

    if (session) {
      await ctx.db.delete(session._id);
    }

    return { success: true };
  },
});

/**
 * Delete all sessions for user
 */
export const deleteAllUserSessions = mutation({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<{ deletedCount: number }> => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    return { deletedCount: sessions.length };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// USER MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get user by ID
 */
export const getUser = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<AuthUser | null> => {
    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("id"), args.userId))
      .first();

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified,
      tier: user.tier,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
      trialEndsAt: user.trialEndsAt,
      preferences: user.preferences,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  },
});

/**
 * Get user by email
 */
export const getUserByEmail = query({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args): Promise<AuthUser | null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified,
      tier: user.tier,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
      trialEndsAt: user.trialEndsAt,
      preferences: user.preferences,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  },
});

/**
 * Create user (internal - called by Better Auth adapter)
 */
export const createUser = mutation({
  args: {
    id: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerified: v.boolean(),
    tier: v.optional(v.string()),
    trialEndsAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AuthUser> => {
    const now = Date.now();

    await ctx.db.insert("users", {
      id: args.id,
      email: args.email,
      name: args.name,
      image: args.image,
      emailVerified: args.emailVerified,
      tier: args.tier || "free",
      trialEndsAt: args.trialEndsAt,
      preferences: {},
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: args.id,
      email: args.email,
      name: args.name,
      image: args.image,
      emailVerified: args.emailVerified,
      tier: args.tier || "free",
      trialEndsAt: args.trialEndsAt,
      preferences: {},
      createdAt: now,
      updatedAt: now,
    };
  },
});

/**
 * Update user
 */
export const updateUser = mutation({
  args: {
    userId: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()),
    tier: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    trialEndsAt: v.optional(v.number()),
    preferences: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<AuthUser | null> => {
    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("id"), args.userId))
      .first();

    if (!user) {
      return null;
    }

    const updates: Record<string, any> = {
      updatedAt: Date.now(),
    };

    if (args.name !== undefined) updates.name = args.name;
    if (args.image !== undefined) updates.image = args.image;
    if (args.emailVerified !== undefined) updates.emailVerified = args.emailVerified;
    if (args.tier !== undefined) updates.tier = args.tier;
    if (args.stripeCustomerId !== undefined) updates.stripeCustomerId = args.stripeCustomerId;
    if (args.stripeSubscriptionId !== undefined) updates.stripeSubscriptionId = args.stripeSubscriptionId;
    if (args.trialEndsAt !== undefined) updates.trialEndsAt = args.trialEndsAt;
    if (args.preferences !== undefined) updates.preferences = args.preferences;

    await ctx.db.patch(user._id, updates);

    return {
      id: user.id,
      email: user.email,
      name: updates.name ?? user.name,
      image: updates.image ?? user.image,
      emailVerified: updates.emailVerified ?? user.emailVerified,
      tier: updates.tier ?? user.tier,
      stripeCustomerId: updates.stripeCustomerId ?? user.stripeCustomerId,
      stripeSubscriptionId: updates.stripeSubscriptionId ?? user.stripeSubscriptionId,
      trialEndsAt: updates.trialEndsAt ?? user.trialEndsAt,
      preferences: updates.preferences ?? user.preferences,
      createdAt: user.createdAt,
      updatedAt: updates.updatedAt,
    };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OAUTH HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Link OAuth account
 */
export const linkAccount = mutation({
  args: {
    id: v.string(),
    userId: v.string(),
    accountId: v.string(),
    providerId: v.string(),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    idToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    tokenType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if account already exists
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_accountId_providerId", (q) =>
        q.eq("accountId", args.accountId).eq("providerId", args.providerId)
      )
      .first();

    if (existing) {
      // Update existing account
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        idToken: args.idToken,
        expiresAt: args.expiresAt,
        scope: args.scope,
        tokenType: args.tokenType,
        updatedAt: now,
      });
      return { success: true, linked: false };
    }

    // Create new account link
    await ctx.db.insert("accounts", {
      id: args.id,
      userId: args.userId,
      accountId: args.accountId,
      providerId: args.providerId,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      idToken: args.idToken,
      expiresAt: args.expiresAt,
      scope: args.scope,
      tokenType: args.tokenType,
      createdAt: now,
      updatedAt: now,
    });
    return { success: true, linked: true };
  },
});

/**
 * Unlink OAuth account
 */
export const unlinkAccount = mutation({
  args: {
    userId: v.string(),
    providerId: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_userId_providerId", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();

    if (account) {
      await ctx.db.delete(account._id);
      return { success: true };
    }

    return { success: false };
  },
});

/**
 * Get OAuth accounts for user
 */
export const getAccounts = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    return accounts.map((account) => ({
      id: account.id,
      providerId: account.providerId,
      createdAt: account.createdAt,
    }));
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VERIFICATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Create verification token
 */
export const createVerification = mutation({
  args: {
    id: v.string(),
    identifier: v.string(),
    value: v.string(),
    expiresAt: v.number(),
    type: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    await ctx.db.insert("verifications", {
      id: args.id,
      identifier: args.identifier,
      value: args.value,
      expiresAt: args.expiresAt,
      type: args.type,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true };
  },
});

/**
 * Verify token
 */
export const verifyToken = mutation({
  args: {
    identifier: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args): Promise<{ valid: boolean; type?: string }> => {
    const verification = await ctx.db
      .query("verifications")
      .withIndex("by_identifier_value", (q) =>
        q.eq("identifier", args.identifier).eq("value", args.value)
      )
      .first();

    if (!verification) {
      return { valid: false };
    }

    // Check expiration
    if (verification.expiresAt < Date.now()) {
      await ctx.db.delete(verification._id);
      return { valid: false };
    }

    // Mark as used
    await ctx.db.patch(verification._id, {
      usedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { valid: true, type: verification.type };
  },
});

/**
 * Delete verification tokens for identifier
 */
export const deleteVerifications = mutation({
  args: {
    identifier: v.string(),
  },
  handler: async (ctx, args): Promise<{ deletedCount: number }> => {
    const verifications = await ctx.db
      .query("verifications")
      .withIndex("by_identifier", (q) => q.eq("identifier", args.identifier))
      .collect();

    for (const v of verifications) {
      await ctx.db.delete(v._id);
    }

    return { deletedCount: verifications.length };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSRF PROTECTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validate CSRF token
 */
export const validateCsrf = query({
  args: {
    sessionToken: v.string(),
    csrfToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ valid: boolean }> => {
    const session = await ctx.db
      .query("sessions")
      .filter((q) => q.eq(q.field("id"), args.sessionToken))
      .first();

    if (!session || session.expiresAt < Date.now()) {
      return { valid: false };
    }

    return { valid: session.csrfToken === args.csrfToken };
  },
});

/**
 * Regenerate CSRF token
 */
export const regenerateCsrf = mutation({
  args: {
    sessionToken: v.string(),
    newCsrfToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const session = await ctx.db
      .query("sessions")
      .filter((q) => q.eq(q.field("id"), args.sessionToken))
      .first();

    if (!session) {
      return { success: false };
    }

    await ctx.db.patch(session._id, {
      csrfToken: args.newCsrfToken,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API KEY AUTHENTICATION (For Python Backend)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validate API key
 * Used by Python backend to authenticate requests
 */
export const validateApiKey = query({
  args: {
    keyHash: v.string(),
  },
  handler: async (ctx, args): Promise<{ valid: boolean; userId?: string; scopes?: string[] }> => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("key", args.keyHash))
      .first();

    if (!apiKey) {
      return { valid: false };
    }

    // Check if revoked
    if (apiKey.revokedAt) {
      return { valid: false };
    }

    // Check expiration
    if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
      return { valid: false };
    }

    return {
      valid: true,
      userId: apiKey.userId,
      scopes: apiKey.scopes,
    };
  },
});

/**
 * Create API key
 */
export const createApiKey = mutation({
  args: {
    id: v.string(),
    key: v.string(),
    prefix: v.string(),
    userId: v.optional(v.string()),
    name: v.string(),
    scopes: v.array(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    await ctx.db.insert("apiKeys", {
      id: args.id,
      key: args.key,
      prefix: args.prefix,
      userId: args.userId,
      name: args.name,
      scopes: args.scopes,
      expiresAt: args.expiresAt,
      createdAt: now,
    });

    return { success: true };
  },
});

/**
 * Revoke API key
 */
export const revokeApiKey = mutation({
  args: {
    keyId: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .filter((q) => q.eq(q.field("id"), args.keyId))
      .first();

    if (!apiKey) {
      return { success: false };
    }

    await ctx.db.patch(apiKey._id, {
      revokedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * List API keys for user
 */
export const listApiKeys = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("revokedAt"), undefined))
      .collect();

    return keys.map((key) => ({
      id: key.id,
      prefix: key.prefix,
      name: key.name,
      scopes: key.scopes,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
    }));
  },
});

/**
 * Update API key last used timestamp
 */
export const touchApiKey = mutation({
  args: {
    keyHash: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("key", args.keyHash))
      .first();

    if (!apiKey) {
      return { success: false };
    }

    await ctx.db.patch(apiKey._id, {
      lastUsedAt: Date.now(),
    });

    return { success: true };
  },
});
