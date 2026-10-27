/**
 * Sandbox env/secrets client — the daemon `/env` endpoints, owned by the SDK.
 * The host never calls `authenticatedFetch('/env...')` itself.
 *
 * These are host-level environment variables / API keys (e.g. tool provider
 * keys, ELEVENLABS_API_KEY) stored in the sandbox, distinct from workspace
 * files. All requests go through `authenticatedFetch`, same auth path as every
 * other daemon call.
 *
 * Every call takes an explicit `baseUrl` (exactly like `triggersRequest` in
 * `./triggers`) rather than reading the module-global "active runtime". A
 * caller that keys its own cache on a specific instance URL (e.g.
 * `use-secrets.ts`'s `instanceUrl`) must talk to THAT instance — falling back
 * to whatever the global active runtime happens to be at call time risks
 * reading/writing secrets on the wrong sandbox.
 */
import { authenticatedFetch } from '../http/auth';

async function envErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}) as { error?: string });
  return body?.error || res.statusText || fallback;
}

function requireBaseUrl(baseUrl: string): string {
  if (!baseUrl) {
    throw new Error('[kortix-runtime] Server URL not ready — sandbox is still loading');
  }
  return baseUrl;
}

/** List all secrets (key → value). Daemon `GET /env`. */
export async function listEnv(baseUrl: string): Promise<Record<string, string>> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/env`);
  if (!res.ok) throw new Error(await envErrorMessage(res, 'Failed to load secrets'));
  const data = await res.json();
  return data.secrets ?? {};
}

/** Set a single secret. Daemon `PUT /env/:key`. */
export async function setEnv(baseUrl: string, key: string, value: string): Promise<void> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/env/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(await envErrorMessage(res, 'Failed to save secret'));
}

/** Delete a single secret. Daemon `DELETE /env/:key`. */
export async function deleteEnv(baseUrl: string, key: string): Promise<void> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/env/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await envErrorMessage(res, 'Failed to delete secret'));
}

/** Grouped namespace for ergonomic use (also available as named exports). */
export const env = {
  list: listEnv,
  set: setEnv,
  delete: deleteEnv,
};
