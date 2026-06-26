import { authenticatedFetch } from '../../platform/auth';
import {
  CLOUD_SANDBOX_SERVER_ID,
  DEFAULT_SERVER_ID,
  PATH_PROXY_URL_REGEX,
  type ServerEntry,
} from './types';
import { getServersApi } from './url-helpers';

// ── API sync helpers (fire-and-forget) ──────────────────────────────────────
// ONLY custom user-added instances are synced to the servers API.
// Managed sandbox entries ('default', 'cloud-sandbox') come from the
// sandboxes table via useSandbox() — they live in zustand/localStorage only.

/** IDs of managed entries that should NOT be synced to the servers API. */
const MANAGED_IDS = new Set([DEFAULT_SERVER_ID, CLOUD_SANDBOX_SERVER_ID]);

/** True if this entry is a managed sandbox (not a custom user entry). */
export function isManagedEntry(s: ServerEntry | string): boolean {
  const id = typeof s === 'string' ? s : s.id;
  // Also matches per-sandbox stable IDs (e.g. "sandbox-<sandboxId>")
  if (MANAGED_IDS.has(id) || id.startsWith('sandbox-')) return true;
  if (typeof s !== 'string') {
    // Older builds leaked managed sandbox proxy URLs into custom-server
    // persistence without provider metadata. If left in localStorage/API sync,
    // the app keeps reconnecting to stale /v1/p/<old-id>/8000 URLs and the
    // backend correctly returns 403. Treat any backend preview-proxy URL as
    // managed/ephemeral so it is stripped and rebuilt from fresh sandbox rows.
    if (s.provider) return true;
    if (s.url && PATH_PROXY_URL_REGEX.test(s.url)) return true;
  }
  return false;
}

function toApiPayload(s: ServerEntry) {
  return {
    id: s.id,
    label: s.label,
    url: s.url,
    isDefault: s.isDefault,
    provider: s.provider,
    sandboxId: s.sandboxId,
    mappedPorts: s.mappedPorts,
  };
}

export function syncServerToApi(server: ServerEntry) {
  if (isManagedEntry(server)) return; // managed entries are not persisted to API
  authenticatedFetch(`${getServersApi()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toApiPayload(server)),
  }, { retryOnAuthError: false }).catch(() => {}); // fire-and-forget
}

export function deleteServerFromApi(id: string) {
  if (isManagedEntry(id)) return;
  authenticatedFetch(`${getServersApi()}/${id}`, { method: 'DELETE' },
    { retryOnAuthError: false }).catch(() => {});
}

export function selectedSandboxPatch(server: ServerEntry | null | undefined) {
  if (!server?.provider && !server?.instanceId && !server?.sandboxId) return {};
  return {
    lastSelectedInstanceId: server.instanceId ?? '',
    lastSelectedSandboxId: server.sandboxId ?? '',
  };
}

/** Bulk sync all servers to API (used on initial hydration). */
export function syncAllToApi(servers: ServerEntry[]) {
  const custom = servers.filter((s) => !isManagedEntry(s));
  if (custom.length === 0) return;
  authenticatedFetch(`${getServersApi()}/sync`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ servers: custom.map(toApiPayload) }),
  }, { retryOnAuthError: false }).catch(() => {});
}

/** Load servers from API, merging authTokens from localStorage entries. */
export async function loadFromApi(localServers: ServerEntry[]): Promise<ServerEntry[] | null> {
  try {
    const res = await authenticatedFetch(getServersApi(), undefined,
      { retryOnAuthError: false });
    if (!res.ok) return null;
    const rows: Array<{
      id: string;
      label: string;
      url: string;
      isDefault: boolean;
      provider: 'daytona' | 'local_docker' | 'justavps' | null;
      sandboxId: string | null;
      mappedPorts: Record<string, string> | null;
    }> = await res.json();
    if (!rows.length) return null;

    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      url: r.url,
      isDefault: r.isDefault,
      provider: r.provider ?? undefined,
      sandboxId: r.sandboxId ?? undefined,
      mappedPorts: r.mappedPorts ?? undefined,
    })).filter((entry) => !isManagedEntry(entry));
  } catch {
    return null;
  }
}
