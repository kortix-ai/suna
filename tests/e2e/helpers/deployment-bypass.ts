/**
 * Vercel deployment-protection bypass, scoped to the deployment origin.
 *
 * Staging and preview sit behind Vercel SSO protection. Automation gets past it
 * with the `x-vercel-protection-bypass` header, and `x-vercel-set-bypass-cookie`
 * turns that one request into a `_vercel_jwt` cookie (Max-Age 604800, Path=/,
 * Secure, HttpOnly, SameSite=None) that authorises every later request to the
 * same host.
 *
 * That header used to live in `playwright.config.ts` under `use.extraHTTPHeaders`,
 * which Chromium applies to EVERY request the context makes — not just the ones
 * going to the protected deployment. Two defects followed.
 *
 * 1. CORS. The browser attached the two headers to cross-origin XHR against
 *    `staging-api.kortix.com`, so Chromium listed them in
 *    `Access-Control-Request-Headers`. The API answers with a fixed
 *    `Access-Control-Allow-Headers` list that does not contain them, so Chromium
 *    failed the real request with `net::ERR_FAILED` after a 204 preflight.
 *    EVERY browser API call on a deployed target died. Release-gate traces show
 *    the exact pair (`204 OPTIONS` then `-1 GET`) for `/v1/accounts`,
 *    `/v1/user-roles`, `/v1/projects/:id/detail` and the rest; the UI rendered
 *    "This project didn't load" and "Failed to load account — Failed to fetch",
 *    which is what failed 9 of the 11 red specs in runs 32306385663 and
 *    32310893789.
 * 2. Secret exposure. `VERCEL_AUTOMATION_BYPASS_SECRET` grants full access to the
 *    protected deployment, and the same trace shows it sent to 16 hosts — among
 *    them googletagmanager.com, connect.facebook.net, doubleclick.net and
 *    cdn-cookieyes.com. A credential must never leave the origin it authorises.
 *
 * So the bypass is a COOKIE here, never a broadcast header. `globalSetup` mints it
 * once against `E2E_BASE_URL` and writes a Playwright storage state; every context
 * starts from that state. The header is sent exactly once, to the deployment host
 * that issues the cookie.
 *
 * The one thing that can undo it is `BrowserContext.clearCookies()`, which
 * `installBrowserSessionDirect` and 01-account-auth call to drop app auth. They
 * use `clearCookiesPreservingBypass` instead, which restores the infrastructure
 * cookies and clears everything else.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext, Cookie } from '@playwright/test';

/**
 * Where `globalSetup` writes the minted state and `playwright.config.ts` reads it.
 * Both sides import this constant so the two can never drift.
 */
export const DEPLOYMENT_BYPASS_STATE_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  '..',
  'test-results',
  'deployment-bypass-state.json',
);

/**
 * Vercel's own cookies. `_vercel_jwt` carries the bypass grant; the SSO nonce
 * cookies belong to the same protection layer. None of them is application
 * state, so clearing "the session" must leave all of them alone.
 */
export function isDeploymentInfrastructureCookie(name: string): boolean {
  return name.startsWith('_vercel_') || name.startsWith('__vercel_');
}

export function deploymentBypassSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? '';
}

/**
 * Headers that ask Vercel to let this ONE request through and hand back the
 * bypass cookie. Only ever sent to the deployment origin.
 */
export function deploymentBypassHeaders(secret: string): Record<string, string> {
  return {
    'x-vercel-protection-bypass': secret,
    'x-vercel-set-bypass-cookie': 'samesitenone',
  };
}

export interface StorageState {
  cookies: Cookie[];
  origins: never[];
}

function parseSetCookie(header: string, host: string): Cookie | null {
  const [pair, ...attributes] = header.split(';');
  const separator = pair.indexOf('=');
  if (separator < 0) return null;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!isDeploymentInfrastructureCookie(name)) return null;
  const read = (key: string): string | undefined =>
    attributes
      .map((entry) => entry.trim())
      .find((entry) => entry.toLowerCase().startsWith(`${key}=`))
      ?.split('=')
      .slice(1)
      .join('=');
  const maxAge = Number.parseInt(read('max-age') ?? '', 10);
  return {
    name,
    value,
    domain: read('domain')?.replace(/^\./, '') ?? host,
    path: read('path') ?? '/',
    expires: Number.isFinite(maxAge) ? Math.floor(Date.now() / 1000) + maxAge : -1,
    httpOnly: attributes.some((entry) => entry.trim().toLowerCase() === 'httponly'),
    secure: attributes.some((entry) => entry.trim().toLowerCase() === 'secure'),
    sameSite: 'None',
  };
}

/**
 * Exchange the bypass secret for the deployment's cookies.
 *
 * Vercel answers the bypass request with a 307 back to the same path plus
 * `Set-Cookie: _vercel_jwt=…`, so the redirect is deliberately not followed.
 */
export async function mintDeploymentBypassState(
  baseURL: string,
  secret: string,
): Promise<StorageState> {
  const target = new URL(baseURL);
  const response = await fetch(target.toString(), {
    headers: deploymentBypassHeaders(secret),
    redirect: 'manual',
  });
  const cookies = response.headers
    .getSetCookie()
    .map((header) => parseSetCookie(header, target.hostname))
    .filter((cookie): cookie is Cookie => cookie !== null);
  if (cookies.length === 0) {
    throw new Error(
      `VERCEL_AUTOMATION_BYPASS_SECRET did not yield a bypass cookie from ${target.origin} ` +
        `(HTTP ${response.status}). Deployment protection would block every navigation.`,
    );
  }
  return { cookies, origins: [] };
}

/**
 * Mint the bypass state and persist it for `use.storageState`.
 *
 * A no-op without a secret: local runs and unprotected deployments need no
 * bypass, and `playwright.config.ts` leaves `storageState` unset there.
 */
export async function writeDeploymentBypassState(
  baseURL: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageState | null> {
  const secret = deploymentBypassSecret(env);
  if (!secret) return null;
  const state = await mintDeploymentBypassState(baseURL, secret);
  await mkdir(dirname(DEPLOYMENT_BYPASS_STATE_PATH), { recursive: true });
  await writeFile(DEPLOYMENT_BYPASS_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/**
 * Drop application cookies and keep the deployment-protection ones.
 *
 * A plain `clearCookies()` also deletes `_vercel_jwt`, after which every
 * navigation 302s to `vercel.com/sso-api` instead of reaching the app.
 */
export async function clearCookiesPreservingBypass(context: BrowserContext): Promise<void> {
  const infrastructure = (await context.cookies()).filter((cookie) =>
    isDeploymentInfrastructureCookie(cookie.name),
  );
  await context.clearCookies();
  if (infrastructure.length > 0) await context.addCookies(infrastructure);
}
