import { Daytona } from '@daytonaio/sdk';
import { config } from '../config';

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
      items?: Array<{ id: string; name: string; state?: string; createdAt?: string; created?: string }>;
      totalPages?: number;
    };
    for (const it of body.items ?? []) {
      out.push({
        id: it.id,
        name: it.name,
        state: it.state ?? 'unknown',
        createdAt: it.createdAt ?? it.created ?? null,
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
