import { Daytona } from '@daytonaio/sdk';
import { config, type SandboxProviderName } from '../config';
import { isPlatinumConfigured } from './platinum';
import { warmSnapshotSetting } from '../platform/services/runtime-settings';

let daytonaClient: Daytona | null = null;

/**
 * Get singleton Daytona SDK client.
 * Used for sandbox provisioning.
 */
export function getDaytona(): Daytona {
  if (!daytonaClient) {
    if (!config.DAYTONA_API_KEY) {
      throw new Error('Missing DAYTONA_API_KEY');
    }

    daytonaClient = new Daytona({
      apiKey: config.DAYTONA_API_KEY,
      apiUrl: config.DAYTONA_SERVER_URL || undefined,
      target: config.DAYTONA_TARGET || undefined,
    });
  }

  return daytonaClient;
}

let daytonaWarmClient: Daytona | null = null;

/**
 * Get the Daytona client pinned to the WARM target (Daytona's VM-class region,
 * e.g. "experimental"), where snapshots preserve full memory/process state.
 *
 * The TS SDK takes `target` on the client, not per-create, so warm sandboxes
 * need their own client. Same API key + server URL as the main client; only the
 * target differs. Returns the main client when no warm target is set.
 */
export function getDaytonaWarm(): Daytona {
  const warmTarget = config.DAYTONA_WARM_TARGET;
  if (!warmTarget) return getDaytona();
  if (!daytonaWarmClient) {
    if (!config.DAYTONA_API_KEY) {
      throw new Error('Missing DAYTONA_API_KEY');
    }
    daytonaWarmClient = new Daytona({
      apiKey: config.DAYTONA_API_KEY,
      apiUrl: config.DAYTONA_SERVER_URL || undefined,
      target: warmTarget,
    });
  }
  return daytonaWarmClient;
}

/**
 * True when warm (memory-state) snapshots are turned on AND a Daytona warm
 * target is configured. The master switch is the DB-backed admin toggle
 * (warmSnapshotSetting, default ON) — NOT an env var — so operators flip it from
 * the admin Providers panel without a redeploy.
 */
export function warmSnapshotsEnabled(): boolean {
  return (
    warmSnapshotSetting().enabled &&
    !!config.DAYTONA_API_KEY &&
    !!config.DAYTONA_WARM_TARGET
  );
}

/**
 * Provider-aware warm-snapshot gate. Every warm code path that can run on EITHER
 * provider checks this. The MASTER switch (warmSnapshotSetting, DB-backed admin
 * toggle, default ON) gates both; each provider then adds its own sub-gate:
 *
 *   - daytona  → warmSnapshotsEnabled() (also needs DAYTONA_WARM_TARGET).
 *   - platinum → just a configured Platinum host. Platinum's warm snapshot is a
 *     per-project STATEFUL template the host CoW-forks, so it needs no warm
 *     "target", only the master toggle + a host.
 *
 * Default ON (warm-fork is pure upside — a failed bake degrades to a cold clone);
 * operators turn it OFF from the admin Providers panel.
 */
export function warmSnapshotsEnabledFor(provider: SandboxProviderName): boolean {
  if (!warmSnapshotSetting().enabled) return false;
  if (provider === 'daytona') return warmSnapshotsEnabled();
  if (provider === 'platinum') return isPlatinumConfigured();
  return false;
}

/**
 * Check if Daytona is configured.
 */
export function isDaytonaConfigured(): boolean {
  return !!config.DAYTONA_API_KEY;
}

export interface DaytonaSnapshotSummary {
  id: string;
  name: string;
  state: string;
  createdAt: string | null;
  /** Last time a sandbox was created from this snapshot (null = never). */
  lastUsedAt: string | null;
  /** Regions the snapshot is bootable in (e.g. ['us','eu'] or ['experimental']). */
  regionIds: string[];
}

function daytonaApiBase(): string {
  return (config.DAYTONA_SERVER_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
}

/**
 * List every snapshot in the org via the REST API (the SDK exposes no stable
 * paginated list). Walks all pages. Used by snapshot reconciliation to detect
 * orphans and enforce the org-wide snapshot quota. Throws on transport / auth
 * failure so callers can skip destructive reconciliation when the view is
 * incomplete (never delete based on a partial list).
 */
export async function listDaytonaSnapshots(): Promise<DaytonaSnapshotSummary[]> {
  if (!config.DAYTONA_API_KEY) throw new Error('Missing DAYTONA_API_KEY');
  const base = daytonaApiBase();
  const out: DaytonaSnapshotSummary[] = [];
  let page = 1;
  // Hard cap on pages so a misbehaving API can't spin us forever.
  for (let guard = 0; guard < 100; guard++) {
    const res = await fetch(`${base}/snapshots?limit=200&page=${page}`, {
      headers: { Authorization: `Bearer ${config.DAYTONA_API_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Daytona list snapshots failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      items?: Array<{ id: string; name: string; state?: string; createdAt?: string; created?: string; lastUsedAt?: string; regionIds?: string[] }>;
      totalPages?: number;
    };
    for (const it of body.items ?? []) {
      out.push({
        id: it.id,
        name: it.name,
        state: it.state ?? 'unknown',
        createdAt: it.createdAt ?? it.created ?? null,
        lastUsedAt: it.lastUsedAt ?? null,
        regionIds: Array.isArray(it.regionIds) ? it.regionIds : [],
      });
    }
    const totalPages = body.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return out;
}

/**
 * Delete a snapshot by its Daytona id. Returns true on success or when the
 * snapshot is already gone (404); false on any other failure. Best-effort —
 * never throws so batch reconciliation can continue past a single bad row.
 */
export async function deleteDaytonaSnapshotById(id: string): Promise<boolean> {
  if (!config.DAYTONA_API_KEY) return false;
  try {
    const res = await fetch(`${daytonaApiBase()}/snapshots/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.DAYTONA_API_KEY}` },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * The exact substring Daytona's REST API returns when the ORG (shared across
 * every environment — prod/dev/staging/laptops) has exceeded its total
 * sandbox disk allocation. Matched case-insensitively against any thrown
 * error's message so both the SDK's typed DaytonaValidationError and a raw
 * fetch failure are recognized the same way — see disk-quota-guard.ts, the
 * live incident (2026-07-02) this backstops: every create/resume org-wide
 * failed once non-archived disk hit the 40000GiB cap.
 */
const DISK_QUOTA_ERROR_SUBSTRING = 'total disk limit exceeded';

export function isDaytonaDiskQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes(DISK_QUOTA_ERROR_SUBSTRING);
}

export interface DaytonaStoppedSandboxSummary {
  id: string;
  disk: number;
  lastActivityAt: string | null;
}

/**
 * Page through org-wide STOPPED (not yet archived) sandboxes, oldest activity
 * first — the safest and highest-yield candidates for an emergency archive
 * sweep (see disk-quota-guard.ts). Unscoped by environment labels
 * deliberately: the disk quota is ORG-wide, so relief has to be too. Bounded
 * by `maxItems` so a pass can never balloon into a full-org scan.
 */
export async function listStoppedDaytonaSandboxesOldestFirst(
  maxItems: number,
): Promise<DaytonaStoppedSandboxSummary[]> {
  if (!config.DAYTONA_API_KEY) throw new Error('Missing DAYTONA_API_KEY');
  const base = daytonaApiBase();
  const out: DaytonaStoppedSandboxSummary[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100 && out.length < maxItems; guard++) {
    const url = new URL(`${base}/sandbox`);
    url.searchParams.set('limit', '200');
    url.searchParams.set('states', 'stopped');
    url.searchParams.set('sort', 'lastActivityAt');
    url.searchParams.set('order', 'asc');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.DAYTONA_API_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Daytona list sandboxes failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      items?: Array<{ id: string; disk?: number; lastActivityAt?: string }>;
      nextCursor?: string | null;
    };
    const items = body.items ?? [];
    for (const it of items) {
      out.push({ id: it.id, disk: it.disk ?? 0, lastActivityAt: it.lastActivityAt ?? null });
      if (out.length >= maxItems) break;
    }
    cursor = body.nextCursor ?? null;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

/**
 * Archive a sandbox by id (stopped → cold storage, still resumable — never
 * destructive). Returns true on success or when the sandbox is already
 * gone/archiving/archived (404/409); false on any other failure — including
 * "cannot be archived for this region/class" (some legacy sandboxClasses),
 * which the caller should just skip rather than treat as fatal. Best-effort —
 * never throws so a batch sweep continues past a single bad row.
 */
export async function archiveDaytonaSandboxById(id: string): Promise<boolean> {
  if (!config.DAYTONA_API_KEY) return false;
  try {
    const res = await fetch(`${daytonaApiBase()}/sandbox/${id}/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.DAYTONA_API_KEY}` },
    });
    return res.ok || res.status === 404 || res.status === 409;
  } catch {
    return false;
  }
}
