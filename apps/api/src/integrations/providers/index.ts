import type { Context } from 'hono';
import { config } from '../../config';
import { PipedreamProvider } from './pipedream';
import { getAccountCreds } from '../credential-store';
import type { AuthProvider } from './types';

export type { AuthProvider, ConnectedAccount, AuthToken, ConnectTokenResult, AppInfo, AppListResult } from './types';

let _default: AuthProvider | null = null;
let _defaultChecked = false;

/**
 * Get or create the global (env-based) provider singleton.
 * This is tier 3 — the fallback when no request headers or account creds exist.
 */
function getDefaultProvider(): AuthProvider | null {
  if (_default) return _default;
  if (_defaultChecked) return null;
  _defaultChecked = true;

  if (config.PIPEDREAM_CLIENT_ID && config.PIPEDREAM_CLIENT_SECRET && config.PIPEDREAM_PROJECT_ID) {
    _default = new PipedreamProvider({
      clientId: config.PIPEDREAM_CLIENT_ID,
      clientSecret: config.PIPEDREAM_CLIENT_SECRET,
      projectId: config.PIPEDREAM_PROJECT_ID,
      environment: config.PIPEDREAM_ENVIRONMENT,
    });
    return _default;
  }

  console.warn('[pipedream] No default Pipedream creds in env — will rely on per-account or per-request creds');
  return null;
}

/**
 * Resolve a PipedreamProvider from request headers (tier 1).
 * Returns null if headers are incomplete.
 */
function fromHeaders(c: Context): AuthProvider | null {
  const clientId = c.req.header('x-pipedream-client-id');
  const clientSecret = c.req.header('x-pipedream-client-secret');
  const projectId = c.req.header('x-pipedream-project-id');

  if (clientId && clientSecret && projectId) {
    const environment = c.req.header('x-pipedream-environment') || 'production';
    return new PipedreamProvider({ clientId, clientSecret, projectId, environment });
  }
  return null;
}

/**
 * 3-tier credential resolution:
 *   1. Request headers (x-pipedream-*) — sandbox proxy override
 *   2. Account credentials (DB)        — per-user, set via sandbox/frontend
 *   3. API defaults (env vars)         — global fallback
 *
 * For routes that have an accountId, pass it to enable tier 2.
 */
export async function getProviderFromRequest(c: Context, accountId?: string): Promise<AuthProvider> {
  // Tier 1: request headers
  const header = fromHeaders(c);
  if (header) return header;

  // Tier 2: per-account DB credentials
  if (accountId) {
    const creds = await getAccountCreds(accountId);
    if (creds) {
      return new PipedreamProvider({
        clientId: creds.client_id,
        clientSecret: creds.client_secret,
        projectId: creds.project_id,
        environment: creds.environment ?? 'production',
      });
    }
  }

  // Tier 3: API env defaults
  const def = getDefaultProvider();
  if (def) return def;

  throw new Error(
    'Pipedream credentials not configured. Either: ' +
    '(1) Set your Pipedream creds in the Integrations page or sandbox secrets manager, or ' +
    '(2) Ask your admin to configure default PIPEDREAM_* env vars on the API. ' +
    'Get credentials from https://pipedream.com/settings/apps.',
  );
}

/** Sync version — only checks headers + env defaults (no DB). For non-async contexts. */
export function getProviderSync(c: Context): AuthProvider {
  const header = fromHeaders(c);
  if (header) return header;
  const def = getDefaultProvider();
  if (def) return def;
  throw new Error('Pipedream credentials not configured.');
}

// Keep backward compat for existing import
export { getDefaultProvider as createAuthProvider };
