import type { Page } from "@playwright/test";
import { supabaseAdminHeaders } from "../../src/core/supabase-admin";

import { clearCookiesPreservingBypass } from "./deployment-bypass";
import { optionalEnvValue, requireEnvValue } from "./env";
import { json } from "./http";

export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

interface AuthOptions {
  supabaseUrl: string;
  password: string;
  envFiles?: string[];
}

function envFiles(options: AuthOptions): string[] {
  return options.envFiles ?? ["apps/web/.env", "apps/api/.env"];
}

function authCookieName(options: AuthOptions): string {
  const files = envFiles(options);
  const appUrl =
    optionalEnvValue("KORTIX_PUBLIC_APP_URL", ...files) ||
    optionalEnvValue("NEXT_PUBLIC_APP_URL", ...files) ||
    optionalEnvValue("NEXT_PUBLIC_URL", ...files) ||
    optionalEnvValue("PUBLIC_URL", ...files);
  if (!appUrl) return "sb-kortix-auth-token";
  try {
    const url = new URL(appUrl);
    if (["localhost", "127.0.0.1"].includes(url.hostname) && url.port) {
      return `sb-kortix-auth-token-${url.port}`;
    }
  } catch {
    // Match the application fallback for invalid or missing app URLs.
  }
  return "sb-kortix-auth-token";
}

function trustedAuthHeader(value: string, name: string): string {
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(value)) {
    throw new Error(
      `${name} contains characters that are not valid in an auth header`,
    );
  }
  return value;
}

export async function createAuthUser(
  email: string,
  options: AuthOptions,
): Promise<AuthUser> {
  const serviceRoleKey = trustedAuthHeader(
    requireEnvValue("SUPABASE_SERVICE_ROLE_KEY", ...envFiles(options)),
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(`${options.supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: supabaseAdminHeaders(serviceRoleKey, { json: true }),
      body: JSON.stringify({
        email,
        password: options.password,
        email_confirm: true,
      }),
    });
    if (response.status === 504 && attempt < 6) {
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const body = await json<{ user?: AuthUser } & AuthUser>(response, 200);
    return body.user ?? body;
  }
  throw new Error("unreachable");
}

export async function deleteAuthUser(
  userId: string,
  options: Omit<AuthOptions, "password">,
): Promise<void> {
  const serviceRoleKey = optionalEnvValue(
    "SUPABASE_SERVICE_ROLE_KEY",
    ...(options.envFiles ?? ["apps/web/.env", "apps/api/.env"]),
  );
  if (!serviceRoleKey) return;
  const trustedServiceRoleKey = trustedAuthHeader(
    serviceRoleKey,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  await fetch(`${options.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: supabaseAdminHeaders(trustedServiceRoleKey),
  }).catch(() => {});
}

export async function confirmAuthUser(
  userId: string,
  options: Omit<AuthOptions, "password">,
): Promise<void> {
  const files = options.envFiles ?? ["apps/web/.env", "apps/api/.env"];
  const serviceRoleKey = trustedAuthHeader(
    requireEnvValue("SUPABASE_SERVICE_ROLE_KEY", ...files),
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  await json(
    await fetch(`${options.supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: supabaseAdminHeaders(serviceRoleKey, { json: true }),
      body: JSON.stringify({ email_confirm: true }),
    }),
    200,
  );
}

export async function signIn(
  email: string,
  options: AuthOptions,
): Promise<AuthSession> {
  const files = envFiles(options);
  const anonKey = trustedAuthHeader(
    optionalEnvValue("SUPABASE_ANON_KEY", ...files) ||
      requireEnvValue("NEXT_PUBLIC_SUPABASE_ANON_KEY", ...files),
    "SUPABASE_ANON_KEY",
  );
  return json<AuthSession>(
    await fetch(`${options.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: options.password }),
    }),
    200,
  );
}

/**
 * Install an already-minted Supabase password-grant session into the browser.
 *
 * Use this when the test target is an authenticated product flow rather than
 * the magic-link/password auth UI. The cookie format matches @supabase/ssr.
 */
export async function installBrowserSessionDirect(
  page: Page,
  session: AuthSession,
  returnUrl: string,
  options: AuthOptions,
): Promise<void> {
  // Drops any previous app session but keeps the deployment-protection cookie:
  // a plain clearCookies() sends the next navigation to vercel.com/sso-api.
  await clearCookiesPreservingBypass(page.context());
  await page.goto("/favicon.png", { waitUntil: "domcontentloaded" });

  const origin = new URL(page.url()).origin;
  const encoded = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;
  const originUrl = new URL(origin);
  const key =
    ["localhost", "127.0.0.1"].includes(originUrl.hostname) && originUrl.port
      ? `sb-kortix-auth-token-${originUrl.port}`
      : authCookieName(options);
  const chunks = encoded.match(/.{1,3180}/g) ?? [];
  await page.context().addCookies(
    chunks.map((value, index) => ({
      name: chunks.length === 1 ? key : `${key}.${index}`,
      value,
      url: origin,
      sameSite: "Lax" as const,
    })),
  );
  // Retry the authenticated landing navigation on a transient origin 5xx. Under
  // the concurrent deployed load the edge launders an overloaded origin into a
  // 503 MAINTENANCE_MODE page; a fresh goto a moment later renders the real app.
  // A 4xx (e.g. a genuine 404) is NOT retried — only origin overload is.
  const maxNav = 4;
  for (let attempt = 1; attempt <= maxNav; attempt += 1) {
    const response = await page.goto(returnUrl, {
      waitUntil: "domcontentloaded",
      timeout: 180_000,
    });
    const status = response?.status() ?? 0;
    if (status < 500 || attempt === maxNav) return;
    await page.waitForTimeout(Math.min(2_000 * attempt, 8_000));
  }
}
