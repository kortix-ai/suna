/**
 * ONE CELL SANDBOX FOR A PROJECT'S SESSIONS, INSTEAD OF ONE EACH.
 *
 * A session's cost is not the isolate, it is the sandbox around it. Measured on
 * dev 2026-09-07 against a warm node: POST /v1/sandboxes 198 ms, the row
 * reaches running at 1296 ms, POST /expose 141 ms, and the edge route goes live
 * 928 ms after that — 2443 ms before anything can answer. On a cell sandbox
 * that already exists, the same session costs 194 ms cold (67 ms to spawn the
 * isolate, 83 ms to write its schema, 44 ms to queue the prompt) and 2 ms on
 * every request after that. So the sandbox is thirteen times the thing it
 * carries.
 *
 * celld already holds many named isolates in one node, each with its own
 * SQLite, which is the isolation boundary a session needs. What stopped a
 * session from using that was addressing: the API's proxy forwards the path and
 * drops the query, and a cell is named by `?c=`. The worker now reads the
 * session out of the PATH as well (`/session/:id/...`), so one sandbox can
 * serve many sessions through the proxy.
 *
 * SCOPE: one host per PROJECT. A project is one repo, one agent config and one
 * account, so its sessions already share everything a cell node would give
 * them. Sharing across projects or accounts is NOT done here and should not be
 * without a tenant story.
 *
 * MEASURED END TO END, dev 2026-09-08, with the flag ON for one project. Four
 * sessions, ONE box (`pi-cell-3637ef187346a4ac`) — the first made it, the rest
 * adopted it and created no sandbox at all:
 *
 *   session          -> ready      -> first assistant text
 *   1 (creates)       2920 ms       7294 ms
 *   2 (adopts)         750 ms       2540 ms
 *   3 (adopts)         662 ms       2404 ms
 *   4 (adopts)         682 ms       2185 ms
 *
 * 4.3x to ready and 3.0x to an answer. The earlier per-component figures above
 * predicted this and are now confirmed at the level a user actually feels.
 *
 * THOSE FIGURES WERE MEASURED WITH A POLLING HARNESS AND READ SLIGHTLY HIGH.
 * Re-measured 2026-09-09 with a single long-poll (`/start?wait_ms=8000`), which
 * returns `ready` on the FIRST call rather than the three the loop made at
 * ~190 ms round trip each:
 *
 *   create 1317 / 1174 / 1027 ms
 *   ready   883 /  520 /  452 ms   one /start call, stage=ready
 *   text    493 /  653 /  484 ms
 *   TOTAL  2693 / 2347 / 1963 ms
 *
 * Also worth correcting: "the rest is the model" was wrong. The turn runs
 * DURING the ready wait, so first text costs ~500 ms after ready, not ~1.9 s.
 * What is left is roughly 500 ms of forced `git fetch` in session create (see
 * projects/lib/sessions.ts, loadProjectAgents) and the client's own round trips.
 *
 * STILL GATED. `KORTIX_CELL_SHARED_HOST_ENABLED` remains off by default and is
 * set only on the dev stack. The reason it was off — "the reaper stops a box
 * when its session is done, and nothing here yet teaches it that a host is
 * shared" — is fixed (projects/reaping/shared-box-stop.ts: a box another ACTIVE
 * session is on is released, not stopped). What is NOT yet done, and what a
 * wider rollout needs: a host outlives every session on it, so nothing stops it
 * when the last one ends, and no tenant story exists for sharing beyond one
 * project.
 */
import { createHash } from 'node:crypto';
import { config } from '../../config';
import { CELL_PORT } from '../providers/platinum';
import type { ClaimedPiWorkerBox } from './pi-worker-pool';

const HOST_PREFIX = 'pi-cell-';
const PROVIDER_CALL_TIMEOUT_MS = 15_000;

/** Platinum names: 1-63 of [a-z0-9-], not starting with '-'. */
const PLATINUM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The host's name IS the registry, exactly as it is for the park pool: Platinum
 * has no label or metadata mutation, so a deterministic name is the only way a
 * second session can find the box the first one made.
 */
export function sharedCellHostName(projectId: string): string {
  const h = createHash('sha256').update(String(projectId)).digest('hex').slice(0, 16);
  return `${HOST_PREFIX}${h}`;
}

/** True when a name is one of ours, so a reaper can tell a host from a session box. */
export function isSharedCellHostName(name: string | null | undefined): boolean {
  const value = String(name ?? '');
  return value.startsWith(HOST_PREFIX) && PLATINUM_NAME.test(value);
}

export function sharedCellHostEnabled(): boolean {
  return config.KORTIX_CELL_SHARED_HOST_ENABLED === true;
}

function platinumBase(): string {
  return (config.PLATINUM_API_URL ?? '').replace(/\/+$/, '');
}

function sandboxApiBase(): string {
  return (config.KORTIX_URL ?? '')
    .replace(/\/+$/, '')
    .replace(/\/v1\/router$/, '')
    .replace(/\/v1$/, '');
}

/** The URL a session uses to reach its cell on a shared host. */
export function sharedCellBaseUrl(externalId: string): string {
  return `${sandboxApiBase()}/v1/p/${externalId}/${CELL_PORT}`;
}

interface Row { id?: string; name?: string | null; state?: string | null; runtime?: string | null; worker?: string | null }

/**
 * The one running host for this project, or null.
 *
 * `running` only: a stopped host would be adopted and then answer nothing,
 * which is the failure the park pool already learned to avoid. A stopped host
 * is left alone rather than started here — starting it is a second decision,
 * with its own latency, and the caller's cold create is the honest fallback.
 */
export async function findSharedCellHost(projectId: string): Promise<string | null> {
  const want = sharedCellHostName(projectId);
  const res = await fetch(`${platinumBase()}/v1/sandboxes?limit=200`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.PLATINUM_API_KEY ?? ''}`,
    },
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`platinum list -> ${res.status}`);
  const body = (await res.json()) as Row[] | { data?: Row[]; sandboxes?: Row[] };
  const rows: Row[] = Array.isArray(body) ? body : (body.data ?? body.sandboxes ?? []);
  const hit = rows.find(
    (r) => r.name === want && String(r.state ?? '').toLowerCase() === 'running' && r.runtime === 'cell',
  );
  return hit?.id ?? null;
}

/**
 * Adopt this project's cell host for a session, or null to cold-create.
 *
 * Null on every failure path, exactly like the park claim: a session that
 * cannot find a host must still start, and a cold create is what it did before
 * this module existed.
 */
export async function adoptSharedCellHost(projectId: string | null | undefined): Promise<ClaimedPiWorkerBox | null> {
  if (!sharedCellHostEnabled()) return null;
  if (!projectId) return null;
  try {
    const externalId = await findSharedCellHost(projectId);
    if (!externalId) return null;
    return { externalId, baseUrl: sharedCellBaseUrl(externalId) };
  } catch (err) {
    console.warn('[cell-host] lookup failed; cold create:', err);
    return null;
  }
}
