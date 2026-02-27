/**
 * Kortix Suna - Better Auth Schema Extension for Convex
 *
 * This schema extends the base Better Auth schema with custom fields
 * for the Suna application. It follows the Better Auth + Convex adapter
 * conventions.
 *
 * References:
 * - https://github.com/convex-dev/better-auth-convex
 * - https://www.better-auth.com/docs/concepts/types
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * User schema extension
 *
 * Extends the base Better Auth user with Suna-specific fields:
 * - tier: Subscription tier (free, starter, pro, enterprise)
 * - stripeCustomerId: Stripe customer ID for billing
 * - stripeSubscriptionId: Active Stripe subscription ID
 * - trialEndsAt: Trial expiration timestamp
 * - preferences: User preferences (flexible JSON)
 */
export const userSchema = defineTable({
  // Base Better Auth fields (required)
  id: v.string(),
  email: v.string(),
  emailVerified: v.boolean(),
  name: v.optional(v.string()),
  image: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),

  // Suna extension fields
  tier: v.optional(v.string()), // "free" | "starter" | "pro" | "enterprise"
  stripeCustomerId: v.optional(v.string()),
  stripeSubscriptionId: v.optional(v.string()),
  trialEndsAt: v.optional(v.number()),
  preferences: v.optional(v.any()), // Flexible preferences object
})
  .index("by_email", ["email"])
  .index("by_stripeCustomerId", ["stripeCustomerId"])
  .index("by_stripeSubscriptionId", ["stripeSubscriptionId"]);

/**
 * Session schema
 *
 * Standard Better Auth session with CSRF protection fields:
 * - csrfToken: Token for CSRF protection
 * - impersonatedBy: Admin user ID if session is impersonated
 */
export const sessionSchema = defineTable({
  // Base Better Auth fields (required)
  id: v.string(),
  userId: v.string(),
  expiresAt: v.number(),
  ipAddress: v.optional(v.string()),
  userAgent: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),

  // CSRF protection
  csrfToken: v.optional(v.string()),

  // Admin impersonation tracking
  impersonatedBy: v.optional(v.string()), // Admin user ID
})
  .index("by_userId", ["userId"])
  .index("by_csrfToken", ["csrfToken"]);

/**
 * Account schema (OAuth providers)
 *
 * Links OAuth provider accounts to users.
 * Supports: github, google, credentials
 */
export const accountSchema = defineTable({
  // Base Better Auth fields (required)
  id: v.string(),
  userId: v.string(),
  accountId: v.string(),
  providerId: v.string(), // "github" | "google" | "credentials"
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  idToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  password: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),

  // Suna extension fields
  scope: v.optional(v.string()), // OAuth scopes
  tokenType: v.optional(v.string()), // Token type (e.g., "Bearer")
})
  .index("by_userId", ["userId"])
  .index("by_userId_providerId", ["userId", "providerId"])
  .index("by_accountId_providerId", ["accountId", "providerId"]);

/**
 * Verification schema
 *
 * Used for email verification, password reset, and other token-based flows.
 */
export const verificationSchema = defineTable({
  // Base Better Auth fields (required)
  id: v.string(),
  identifier: v.string(), // Email or other identifier
  value: v.string(), // Token value
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),

  // Suna extension fields
  type: v.optional(v.string()), // "email_verification" | "password_reset" | "magic_link"
  usedAt: v.optional(v.number()), // When the token was used
})
  .index("by_identifier", ["identifier"])
  .index("by_identifier_value", ["identifier", "value"]);

/**
 * API Key schema (Service Authentication)
 *
 * For Python backend and external service authentication.
 * Supports both user-scoped and service-scoped API keys.
 */
export const apiKeySchema = defineTable({
  id: v.string(),
  key: v.string(), // Hashed API key
  prefix: v.string(), // Key prefix for identification (e.g., "sk_live_")
  userId: v.optional(v.string()), // User ID (null for service keys)
  name: v.string(), // Key name/description
  scopes: v.array(v.string()), // Permission scopes
  expiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
  createdAt: v.number(),
  revokedAt: v.optional(v.number()),
})
  .index("by_key", ["key"])
  .index("by_userId", ["userId"])
  .index("by_prefix", ["prefix"]);

/**
 * Rate limit schema
 *
 * Tracks API usage for rate limiting.
 */
export const rateLimitSchema = defineTable({
  id: v.string(),
  identifier: v.string(), // IP, user ID, or API key
  endpoint: v.string(), // API endpoint or action
  count: v.number(),
  windowStart: v.number(),
  expiresAt: v.number(),
})
  .index("by_identifier_endpoint", ["identifier", "endpoint"])
  .index("by_expiresAt", ["expiresAt"]);

/**
 * Export all schemas for Better Auth Convex adapter
 */
export const betterAuthSchema = {
  users: userSchema,
  sessions: sessionSchema,
  accounts: accountSchema,
  verifications: verificationSchema,
  apiKeys: apiKeySchema,
  rateLimits: rateLimitSchema,
};

export default betterAuthSchema;
