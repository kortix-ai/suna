/**
 * The pi worker pool on PLATINUM — parked microVMs claimed at session create,
 * the same accelerator `pi-worker-pool.ts` gives a Daytona deployment.
 *
 * Why a second module rather than a provider seam inside that one: its whole
 * registry is Daytona labels, and its comments record two live incidents that
 * shaped it (stale labels in the paginated list; a reap that would have deleted
 * a claimed box). Rewriting it in place to serve both providers would put that
 * proven path at risk for a deployment it does not run on. This file is
 * additive — a Platinum-only deployment gets a pool, a Daytona one is untouched.
 *
 * THE NAME IS THE REGISTRY. Platinum has no label or metadata mutation: PATCH
 * /v1/sandboxes/:id renames, and that is the only field a claim can flip. So a
 * parked box is named `pi-park-<hash8>-<token>` and a claim RENAMES it to the
 * session's own deterministic name. That single mutation both hands the box to
 * the session and removes it from this pool's view, which is exactly the
 * property the Daytona path needs two label writes to get — and it cannot half
 * apply, so there is no window where a claimed box still looks parked.
 *
 * Every failure path returns null / logs and moves on: the caller cold-creates,
 * exactly as with the Daytona pool. The pool is off unless
 * KORTIX_PI_WORKER_POOL_TARGET > 0.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../../config';
import { ensurePiWorkerImage } from '../../snapshots/builder';
import { withTimeout } from '../../shared/with-timeout';
import { providerAutoStopBackstopMinutes } from '../providers';
import type { ClaimedPiWorkerBox } from './pi-worker-pool';

const PARK_PREFIX = 'pi-park-';
const PROVIDER_CALL_TIMEOUT_MS = 30_000;
const CLAIM_REQUEST_TIMEOUT_MS = 5_000;
const MAX_CREATES_PER_MAINTAIN = 2;

export interface PlatinumParkedBox {
  externalId: string;
  name: string;
  state: string;
  createdAt: Date | null;
  contentHash: string;
  parkToken: string;
}

/**
 * `pi-park-<hash8>-<token>`, inside Platinum's name rules (1-63 of
 * [a-z0-9-], not starting with '-'). The content hash rides in the name so a
 * stale-image box is reapable from the list alone, and the token proves to the
 * park server that the claimer found this box through the pool.
 */
export function parkName(contentHash: string, token: string): string {
  return `${PARK_PREFIX}${contentHash.slice(0, 8).toLowerCase()}-${token}`;
}

/** The inverse of {@link parkName}; null when the name is not one of ours. */
export function parseParkName(name: string | null | undefined): { hash8: string; token: string } | null {
  const value = String(name ?? '');
  if (!value.startsWith(PARK_PREFIX)) return null;
  const rest = value.slice(PARK_PREFIX.length);
  const dash = rest.indexOf('-');
  if (dash <= 0) return null;
  const hash8 = rest.slice(0, dash);
  const token = rest.slice(dash + 1);
  if (!hash8 || !token) return null;
  return { hash8, token };
}

/** A fresh park token: 24 lowercase base36 characters, safe in a sandbox name. */
export function newParkToken(): string {
  return randomBytes(16).toString('hex').slice(0, 24);
}

function platinumBase(): string {
  return (config.PLATINUM_API_URL ?? '').replace(/\/+$/, '');
}

async function platinumJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${platinumBase()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.PLATINUM_API_KEY ?? ''}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

type PlatinumSandboxRow = {
  id: string;
  name?: string | null;
  state?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};

/** Parked boxes, read from the org's sandbox list by NAME (the registry). */
export function parkedFromRows(rows: PlatinumSandboxRow[]): PlatinumParkedBox[] {
  const out: PlatinumParkedBox[] = [];
  for (const row of rows) {
    const parsed = parseParkName(row?.name);
    if (!row?.id || !parsed) continue;
    const created = row.createdAt ?? row.created_at ?? null;
    out.push({
      externalId: row.id,
      name: String(row.name),
      state: String(row.state ?? ''),
      createdAt: created ? new Date(created) : null,
      contentHash: parsed.hash8,
      parkToken: parsed.token,
    });
  }
  return out;
}

async function listParked(): Promise<PlatinumParkedBox[]> {
  const rows = await platinumJson<PlatinumSandboxRow[] | { sandboxes?: PlatinumSandboxRow[] }>(
    '/v1/sandboxes?limit=100',
  );
  return parkedFromRows(Array.isArray(rows) ? rows : (rows.sandboxes ?? []));
}

/**
 * Re-read one box directly before anything destructive or before a claim: the
 * list is a snapshot, and a box another instance claimed a moment ago is no
 * longer ours. Same authority rule the Daytona pool learned live — there, from
 * stale labels; here, because the rename that de-registers a box may not have
 * reached the list yet.
 */
async function stillParked(externalId: string): Promise<PlatinumParkedBox | null> {
  try {
    const row = await platinumJson<PlatinumSandboxRow>(`/v1/sandboxes/${externalId}`);
    return parkedFromRows([row])[0] ?? null;
  } catch {
    return null;   // unknowable is not reapable
  }
}

async function createParked(templateId: string, contentHash: string): Promise<void> {
  const token = newParkToken();
  await platinumJson('/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000', {
    method: 'POST',
    body: JSON.stringify({
      template: templateId,
      name: parkName(contentHash, token),
      exposed_ports: [8000],
      auto_stop_minutes: Math.max(1, config.KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES),
      envVars: {
        KORTIX_PI_PARK: '1',
        KORTIX_PI_PARK_TOKEN: token,
        KORTIX_API_URL: `${(config.KORTIX_URL ?? '').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`,
        KORTIX_SERVICE_PORT: '8000',
      },
      metadata: { 'kortix.managed': 'true', 'kortix.piworker-park': '1' },
    }),
  });
}

async function removeBox(externalId: string): Promise<void> {
  await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'DELETE' });
}

/** The claim URL for a parked box — the API's own sandbox proxy, as sessions use. */
export function claimUrl(externalId: string): string {
  const root = (config.KORTIX_URL ?? '').replace(/\/+$/, '').replace(/\/v1\/router$/, '').replace(/\/v1$/, '');
  return `${root}/v1/p/${externalId}/8000/kortix/claim`;
}

/** The base URL a claimed box serves the session on. */
export function claimedBaseUrl(externalId: string): string {
  const root = (config.KORTIX_URL ?? '').replace(/\/+$/, '').replace(/\/v1\/router$/, '').replace(/\/v1$/, '');
  return `${root}/v1/p/${externalId}/8000`;
}

/**
 * Claim one parked box for a session: POST the session env to its park server,
 * then RENAME it to the session's own box name — the rename is what removes it
 * from this pool, so a won claim can never be reaped as a parked box.
 * Returns null when nothing could be claimed; the caller cold-creates.
 */
export async function claimParkedPlatinumBox(
  claimEnv: Record<string, string>,
  sessionBoxName: string,
): Promise<ClaimedPiWorkerBox | null> {
  if (config.KORTIX_PI_WORKER_POOL_TARGET <= 0) return null;
  let candidates: PlatinumParkedBox[];
  let currentHash8: string;
  try {
    const image = await ensurePiWorkerImage({ provider: 'platinum' });
    currentHash8 = image.contentHash.slice(0, 8).toLowerCase();
    candidates = (await listParked()).filter(
      (box) => box.contentHash === currentHash8 && box.state.toLowerCase() === 'running',
    );
  } catch (err) {
    console.warn('[pi-pool/platinum] listing failed; falling back to cold create:', err);
    return null;
  }
  // Oldest first: steady turnover keeps no box near its self-reclaim age.
  candidates.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  for (const box of candidates.slice(0, 3)) {
    const live = await stillParked(box.externalId);
    if (!live) continue;                                   // claimed by someone else
    try {
      const res = await fetch(claimUrl(box.externalId), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-park-token': live.parkToken },
        body: JSON.stringify({ env: claimEnv }),
        signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS),
      });
      if (res.status === 409) continue;                    // another instance won it
      if (!res.ok) {
        console.warn(`[pi-pool/platinum] claim of ${box.externalId} failed: HTTP ${res.status}`);
        continue;
      }
      // The claim is won. The rename hands the box to the session AND takes it
      // out of the pool in one mutation; a failure here leaves a claimed box
      // wearing a park name, which the next maintain() re-reads directly and
      // skips, and the self-reclaim age is the backstop.
      await platinumJson(`/v1/sandboxes/${box.externalId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: sessionBoxName }),
      }).catch((err: unknown) =>
        console.warn(`[pi-pool/platinum] rename of claimed ${box.externalId} failed:`, err),
      );
      return { externalId: box.externalId, baseUrl: claimedBaseUrl(box.externalId) };
    } catch (err) {
      console.warn(`[pi-pool/platinum] claim attempt on ${box.externalId} errored:`, err);
    }
  }
  return null;
}

let maintainInFlight: Promise<void> | null = null;

/** Reconcile the Platinum pool toward its target. Never throws. */
export function maintainPlatinumPiWorkerPool(): Promise<void> {
  if (config.KORTIX_PI_WORKER_POOL_TARGET <= 0) return Promise.resolve();
  if (maintainInFlight) return maintainInFlight;
  maintainInFlight = (async () => {
    const target = config.KORTIX_PI_WORKER_POOL_TARGET;
    const maxAgeMs = config.KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES * 60_000;
    try {
      const image = await ensurePiWorkerImage({ provider: 'platinum' });
      const hash8 = image.contentHash.slice(0, 8).toLowerCase();
      const listed = await listParked();
      const now = Date.now();
      const alive: PlatinumParkedBox[] = [];
      const reap: PlatinumParkedBox[] = [];
      for (const box of listed) {
        const live = await stillParked(box.externalId);
        if (!live) continue;                               // no longer ours
        const dead = ['stopped', 'failed-start', 'deleted', 'error'].includes(live.state.toLowerCase());
        const stale = live.contentHash !== hash8;
        const overAge = live.createdAt !== null && now - live.createdAt.getTime() > maxAgeMs;
        (dead || stale || overAge ? reap : alive).push(live);
      }
      const surplus = Math.max(0, alive.length - target);
      for (const box of [...reap, ...alive.slice(0, surplus)]) {
        await removeBox(box.externalId).catch((err) =>
          console.warn(`[pi-pool/platinum] reap of ${box.externalId} failed:`, err),
        );
      }
      const missing = Math.max(0, target - (alive.length - surplus));
      for (let i = 0; i < Math.min(missing, MAX_CREATES_PER_MAINTAIN); i++) {
        await withTimeout(
          createParked(image.snapshotName, image.contentHash),
          PROVIDER_CALL_TIMEOUT_MS + 60_000,
          'platinum create(parked pi worker)',
        ).catch((err) => console.warn('[pi-pool/platinum] park create failed:', err));
      }
    } catch (err) {
      console.warn('[pi-pool/platinum] maintain failed:', err);
    }
  })().finally(() => {
    maintainInFlight = null;
  });
  return maintainInFlight;
}

/** The backstop a claimed box inherits until the session's own lifecycle takes over. */
export const claimedAutoStopMinutes = (): number => providerAutoStopBackstopMinutes();
