/**
 * Sandbox env/secrets client — the daemon `/env` endpoints, owned by the SDK.
 * The host never calls `authenticatedFetch('/env...')` itself.
 *
 * These are host-level environment variables / API keys (e.g. tool provider
 * keys, ELEVENLABS_API_KEY) stored in the sandbox, distinct from workspace
 * files. All requests go through the active runtime's `authenticatedFetch`,
 * same auth path as every other daemon call.
 */
import { authenticatedFetch } from '../platform/auth';
import { getActiveOpenCodeUrl } from '../state/server-store/active';

async function envErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}) as { error?: string });
  return body?.error || res.statusText || `HTTP ${res.status}`;
}

function requireActiveUrl(): string {
  const url = getActiveOpenCodeUrl();
  if (!url) {
    throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
  }
  return url;
}

/** List all secrets (key → value). Daemon `GET /env`. */
export async function listEnv(): Promise<Record<string, string>> {
  const baseUrl = requireActiveUrl();
  const res = await authenticatedFetch(`${baseUrl}/env`);
  if (!res.ok) throw new Error(await envErrorMessage(res));
  const data = await res.json();
  return data.secrets ?? {};
}

/** Set a single secret. Daemon `PUT /env/:key`. */
export async function setEnv(key: string, value: string): Promise<void> {
  const baseUrl = requireActiveUrl();
  const res = await authenticatedFetch(`${baseUrl}/env/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(await envErrorMessage(res));
}

/** Delete a single secret. Daemon `DELETE /env/:key`. */
export async function deleteEnv(key: string): Promise<void> {
  const baseUrl = requireActiveUrl();
  const res = await authenticatedFetch(`${baseUrl}/env/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await envErrorMessage(res));
}

/** Grouped namespace for ergonomic use (also available as named exports). */
export const env = {
  list: listEnv,
  set: setEnv,
  delete: deleteEnv,
};
