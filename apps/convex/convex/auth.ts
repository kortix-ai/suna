/**
 * Kortix Suna - Main Auth Configuration
 *
 * This module provides auth configuration types and utilities.
 * The actual Better Auth instance is created in the Next.js frontend
 * using the @convex-dev/better-auth adapter.
 *
 * Features:
 * - Email/password authentication
 * - OAuth providers (GitHub, Google)
 * - Session management with CSRF protection
 * - API key authentication for Python backend
 *
 * @see https://www.better-auth.com/docs
 * @see https://github.com/convex-dev/better-auth-convex
 */

import { v } from "convex/values";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuthConfig {
  /**
   * Better Auth instance
   */
  auth: unknown;

  /**
   * Convex adapter instance
   */
  adapter: unknown;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectURI?: string;
}

export interface AuthOptions {
  /**
   * Base URL for the application
   */
  baseURL: string;

  /**
   * Secret for signing tokens
   */
  secret: string;

  /**
   * GitHub OAuth configuration
   */
  github?: OAuthProviderConfig;

  /**
   * Google OAuth configuration
   */
  google?: OAuthProviderConfig;

  /**
   * Session expiration in seconds (default: 7 days)
   */
  sessionExpiresIn?: number;

  /**
   * Enable CSRF protection
   */
  enableCsrf?: boolean;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BETTER AUTH CONFIGURATION OPTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Better Auth configuration options
 *
 * These options should be used when creating the Better Auth instance
 * in the Next.js frontend. The actual auth instance cannot be created
 * in Convex functions due to runtime constraints.
 *
 * @example
 * ```typescript
 * // In Next.js frontend (e.g., src/lib/auth.ts)
 * import { betterAuth } from "better-auth";
 * import { convex } from "@convex-dev/better-auth";
 * import { authOptions } from "@convex/_generated/api";
 *
 * export const auth = betterAuth({
 *   ...authOptions,
 *   database: convex(),
 * });
 * ```
 */
export const authOptions: AuthOptions = {
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET || "dev-secret-change-in-production",
  sessionExpiresIn: 60 * 60 * 24 * 7, // 7 days
  enableCsrf: true,

  // OAuth providers - configured via environment variables
  github: process.env.GITHUB_CLIENT_ID
    ? {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
        redirectURI: `${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/callback/github`,
      }
    : undefined,

  google: process.env.GOOGLE_CLIENT_ID
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        redirectURI: `${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/callback/google`,
      }
    : undefined,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API KEY AUTHENTICATION (For Python Backend)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * API Key authentication options
 */
export interface ApiKeyOptions {
  /**
   * Key prefix for identification (e.g., "sk_live_", "sk_test_")
   */
  prefix: string;

  /**
   * Key expiration in seconds (optional)
   */
  expiresIn?: number;

  /**
   * Permission scopes
   */
  scopes: string[];

  /**
   * User ID to associate with the key
   */
  userId?: string;

  /**
   * Key name/description
   */
  name: string;
}

/**
 * Generate a secure random string for API keys
 *
 * @param length - Length of the random string
 * @returns Random hex string
 */
export function generateRandomHex(length: number = 32): string {
  const bytes = new Uint8Array(length);
  // Use crypto.getRandomValues for secure random
  // Note: In Convex, we use the global crypto object
  const cryptoGlobal = globalThis as { crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } };
  if (cryptoGlobal.crypto?.getRandomValues) {
    cryptoGlobal.crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments without crypto
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a secure API key
 *
 * @param prefix - Key prefix for identification
 * @returns Generated API key (not hashed - store the hash, return the key to user once)
 */
export function generateApiKey(prefix: string = "sk_"): string {
  const randomHex = generateRandomHex(32);
  return `${prefix}${randomHex}`;
}

/**
 * Validate API key format
 *
 * @param key - API key to validate
 * @param prefix - Expected prefix
 * @returns True if key format is valid
 */
export function validateApiKeyFormat(key: string, prefix: string = "sk_"): boolean {
  if (!key || typeof key !== "string") {
    return false;
  }

  // Check prefix
  if (!key.startsWith(prefix)) {
    return false;
  }

  // Check length (prefix + 64 hex chars)
  if (key.length !== prefix.length + 64) {
    return false;
  }

  // Check that remaining characters are hex
  const hexPart = key.slice(prefix.length);
  return /^[0-9a-f]{64}$/.test(hexPart);
}

/**
 * API Key scope definitions
 */
export const API_KEY_SCOPES = {
  // Read access
  READ_THREADS: "read:threads",
  READ_MESSAGES: "read:messages",
  READ_AGENTS: "read:agents",
  READ_MEMORIES: "read:memories",
  READ_FACTS: "read:facts",

  // Write access
  WRITE_THREADS: "write:threads",
  WRITE_MESSAGES: "write:messages",
  WRITE_AGENTS: "write:agents",
  WRITE_MEMORIES: "write:memories",
  WRITE_FACTS: "write:facts",

  // Admin access
  ADMIN_ALL: "admin:all",
  ADMIN_USERS: "admin:users",
  ADMIN_BILLING: "admin:billing",

  // Service access (for Python backend)
  SERVICE_EXECUTE: "service:execute",
  SERVICE_SANDBOX: "service:sandbox",
  SERVICE_TRIGGERS: "service:triggers",
} as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[keyof typeof API_KEY_SCOPES];

/**
 * Predefined scope sets for common use cases
 */
export const API_KEY_SCOPE_SETS = {
  /**
   * Full read access
   */
  READ_ONLY: [
    API_KEY_SCOPES.READ_THREADS,
    API_KEY_SCOPES.READ_MESSAGES,
    API_KEY_SCOPES.READ_AGENTS,
    API_KEY_SCOPES.READ_MEMORIES,
    API_KEY_SCOPES.READ_FACTS,
  ],

  /**
   * Full read/write access
   */
  FULL_ACCESS: [
    API_KEY_SCOPES.READ_THREADS,
    API_KEY_SCOPES.READ_MESSAGES,
    API_KEY_SCOPES.READ_AGENTS,
    API_KEY_SCOPES.READ_MEMORIES,
    API_KEY_SCOPES.READ_FACTS,
    API_KEY_SCOPES.WRITE_THREADS,
    API_KEY_SCOPES.WRITE_MESSAGES,
    API_KEY_SCOPES.WRITE_AGENTS,
    API_KEY_SCOPES.WRITE_MEMORIES,
    API_KEY_SCOPES.WRITE_FACTS,
  ],

  /**
   * Python backend service access
   */
  PYTHON_BACKEND: [
    API_KEY_SCOPES.SERVICE_EXECUTE,
    API_KEY_SCOPES.SERVICE_SANDBOX,
    API_KEY_SCOPES.SERVICE_TRIGGERS,
    API_KEY_SCOPES.READ_THREADS,
    API_KEY_SCOPES.READ_MESSAGES,
    API_KEY_SCOPES.WRITE_THREADS,
    API_KEY_SCOPES.WRITE_MESSAGES,
    API_KEY_SCOPES.READ_MEMORIES,
    API_KEY_SCOPES.WRITE_MEMORIES,
    API_KEY_SCOPES.READ_FACTS,
    API_KEY_SCOPES.WRITE_FACTS,
  ],

  /**
   * Admin access
   */
  ADMIN: [
    API_KEY_SCOPES.ADMIN_ALL,
    API_KEY_SCOPES.ADMIN_USERS,
    API_KEY_SCOPES.ADMIN_BILLING,
  ],
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSRF PROTECTION UTILITIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Generate a CSRF token
 *
 * @returns Random CSRF token
 */
export function generateCsrfToken(): string {
  return generateRandomHex(32);
}

/**
 * Validate CSRF token matches session
 *
 * @param sessionToken - Token from session
 * @param providedToken - Token provided in request
 * @returns True if tokens match
 */
export function validateCsrfToken(sessionToken: string, providedToken: string): boolean {
  if (!sessionToken || !providedToken) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  if (sessionToken.length !== providedToken.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < sessionToken.length; i++) {
    result |= sessionToken.charCodeAt(i) ^ providedToken.charCodeAt(i);
  }

  return result === 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION UTILITIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Session cookie configuration
 */
export const SESSION_COOKIE_CONFIG = {
  name: "session_token",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 7, // 7 days
  path: "/",
};

/**
 * CSRF cookie configuration
 */
export const CSRF_COOKIE_CONFIG = {
  name: "csrf_token",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24, // 1 day
  path: "/",
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ENVIRONMENT VARIABLE REQUIREMENTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Required environment variables for Better Auth
 *
 * These must be set in the Convex dashboard:
 * - BETTER_AUTH_SECRET: Secret key for signing tokens (generate with: openssl rand -base64 32)
 * - BETTER_AUTH_URL: Base URL of your application
 *
 * Optional OAuth environment variables:
 * - GITHUB_CLIENT_ID: GitHub OAuth app client ID
 * - GITHUB_CLIENT_SECRET: GitHub OAuth app client secret
 * - GOOGLE_CLIENT_ID: Google OAuth app client ID
 * - GOOGLE_CLIENT_SECRET: Google OAuth app client secret
 */
export const REQUIRED_ENV_VARS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
];

export const OPTIONAL_OAUTH_ENV_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export {
  authOptions as defaultAuthOptions,
  API_KEY_SCOPES as AUTH_SCOPES,
  API_KEY_SCOPE_SETS as AUTH_SCOPE_SETS,
};
