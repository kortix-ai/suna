/**
 * Pi worker pool (harness/worker split P1.8): parked boxes of the shared
 * pi-worker snapshot, claimed at session create.
 *
 * Why: the worker itself boots in 9 ms, but a cold Daytona create + box boot
 * costs ~4 s of the ~8.5 s cold path (measured on dev 2026-08-27, PR #6966
 * thread). A parked box is already running; a claim delivers the session env
 * over the box's park server and the box fetches its per-commit artifact and
 * execs the worker — no provider create on the critical path.
 *
 * Design constraints, deliberately:
 * - **No DB table.** Daytona labels are the registry (`kortix.piworker-park`,
 *   scoped by the managed env labels). The park server accepts exactly ONE
 *   claim (409 after), so racing API instances need no shared lock — the box
 *   itself is the serialization point.
 * - **Pure accelerator.** Every failure path returns null and the caller runs
 *   the ordinary cold create. The pool can be turned off (target 0, the
 *   default) with zero behavior change.
 * - **Self-reclaiming.** Parked boxes are created with a Daytona auto-stop at
 *   the pool max age, so orphans die even if every API instance does.
 * - A parked box holds NO session token — only its own random park token.
 *   The claim carries the session env; the box's preview endpoint is private
 *   (Daytona preview token, held server-side only).
 */
import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { ensurePiWorkerImage } from '../../snapshots/builder';
import { getDaytona } from '../../shared/daytona';
import { withTimeout } from '../../shared/with-timeout';
import { managedSandboxLabels } from '../providers/daytona';
import { providerAutoStopBackstopMinutes } from '../providers';

const PARK_LABEL = 'kortix.piworker-park';
const HASH_LABEL = 'kortix.piworker-hash';
const TOKEN_LABEL = 'kortix.piworker-park-token';
const PROVIDER_CALL_TIMEOUT_MS = 30_000;
const CLAIM_REQUEST_TIMEOUT_MS = 5_000;
/** Bound refill bursts so a mass-reap never stampedes provider create. */
const MAX_CREATES_PER_MAINTAIN = 2;

export interface ParkedBox {
  externalId: string;
  state: string;
  createdAt: Date | null;
  contentHash: string | null;
  parkToken: string | null;
}

export interface ClaimedPiWorkerBox {
  externalId: string;
  baseUrl: string;
}

export function piWorkerPoolEnabled(): boolean {
  return config.KORTIX_PI_WORKER_POOL_TARGET > 0;
}

/** Same origin derivation as the Daytona adapter's create(). */
function kortixApiRoot(): string {
  return config.KORTIX_URL.replace(/\/+$/, '')
    .replace(/\/v1\/router$/, '')
    .replace(/\/v1$/, '');
}

async function listParkedBoxes(): Promise<ParkedBox[]> {
  const out: ParkedBox[] = [];
  await withTimeout(
    (async () => {
      for await (const box of getDaytona().list({
        labels: { ...managedSandboxLabels(), [PARK_LABEL]: '1' },
        limit: 100,
      } as never)) {
        const raw = box as unknown as {
          id?: string;
          state?: string;
          createdAt?: string | Date;
          labels?: Record<string, string>;
        };
        if (!raw.id) continue;
        out.push({
          externalId: raw.id,
          state: String(raw.state ?? ''),
          createdAt: raw.createdAt ? new Date(raw.createdAt) : null,
          contentHash: raw.labels?.[HASH_LABEL] ?? null,
          parkToken: raw.labels?.[TOKEN_LABEL] ?? null,
        });
      }
    })(),
    PROVIDER_CALL_TIMEOUT_MS,
    'Daytona list(parked pi workers)',
  );
  return out;
}

async function createParkedBox(snapshotName: string, contentHash: string): Promise<void> {
  const parkToken = randomUUID();
  await withTimeout(
    getDaytona().create(
      {
        snapshot: snapshotName,
        envVars: {
          KORTIX_PI_PARK: '1',
          KORTIX_PI_PARK_TOKEN: parkToken,
          // Static per environment; everything session-specific arrives with
          // the claim and overrides the park env.
          KORTIX_API_URL: `${kortixApiRoot()}/v1`,
          KORTIX_SERVICE_PORT: '8000',
        },
        labels: {
          ...managedSandboxLabels(),
          [PARK_LABEL]: '1',
          [HASH_LABEL]: contentHash,
          [TOKEN_LABEL]: parkToken,
        },
        // Self-reclaim backstop: a parked box the reaper never reaches stops
        // itself at max age. Claim flips this to the standard session value.
        autoStopInterval: Math.max(1, config.KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES),
        autoArchiveInterval: config.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES,
        autoDeleteInterval: config.KORTIX_SANDBOX_AUTODELETE_MINUTES,
        public: false,
      } as never,
      { timeout: 30 },
    ),
    PROVIDER_CALL_TIMEOUT_MS,
    'Daytona create(parked pi worker)',
  );
}

async function removeBox(externalId: string): Promise<void> {
  const daytona = getDaytona();
  const sandbox = await withTimeout(
    daytona.get(externalId),
    PROVIDER_CALL_TIMEOUT_MS,
    `Daytona get(${externalId})`,
  );
  await withTimeout(
    daytona.delete(sandbox as never),
    PROVIDER_CALL_TIMEOUT_MS,
    `Daytona delete(${externalId})`,
  );
}

/**
 * Claim one parked, current-hash box: POST the session env to its park server.
 * First 200 wins; 409 means another instance got there first — try the next
 * box. Returns null when no box could be claimed (caller cold-creates).
 */
export async function claimParkedPiWorkerBox(
  claimEnv: Record<string, string>,
): Promise<ClaimedPiWorkerBox | null> {
  if (!piWorkerPoolEnabled()) return null;
  let candidates: ParkedBox[];
  let currentHash: string;
  try {
    // Memoized after fix 2 — this does not add a provider round trip.
    const image = await ensurePiWorkerImage({ provider: 'daytona' });
    currentHash = image.contentHash;
    candidates = (await listParkedBoxes()).filter(
      (box) =>
        box.contentHash === currentHash &&
        box.parkToken &&
        box.state.toLowerCase() === 'started',
    );
  } catch (err) {
    console.warn('[pi-pool] claim listing failed; falling back to cold create:', err);
    return null;
  }
  // Oldest first: steady turnover keeps no box near its self-reclaim age.
  candidates.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  const daytona = getDaytona();
  for (const box of candidates.slice(0, 3)) {
    try {
      const sandbox = await withTimeout(
        daytona.get(box.externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${box.externalId})`,
      );
      // The list can serve stale labels (see verifyStillParked). The direct
      // object is authoritative — a box already claimed by another session
      // has lost its park label and must not be dialled.
      const liveLabels =
        (sandbox as unknown as { labels?: Record<string, string> }).labels ?? {};
      if (liveLabels[PARK_LABEL] !== '1') continue;
      const preview = await withTimeout(
        (sandbox as unknown as {
          getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
        }).getPreviewLink(8000),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona getPreviewLink(${box.externalId}:8000)`,
      );
      const res = await fetch(`${preview.url.replace(/\/+$/, '')}/kortix/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-park-token': box.parkToken as string,
          ...(preview.token ? { 'x-daytona-preview-token': preview.token } : {}),
        },
        body: JSON.stringify({ env: claimEnv }),
        signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS),
      });
      if (res.status === 409) continue; // another instance won this box
      if (!res.ok) {
        console.warn(`[pi-pool] claim of ${box.externalId} failed: HTTP ${res.status}`);
        continue;
      }
      // Best effort AFTER the claim is won: leave the pool registry and take
      // the standard session lifecycle. Failure here never voids the claim —
      // the box already booted the session; the self-reclaim age is the
      // worst-case backstop and the reaper skips claimed boxes by label.
      const mutable = sandbox as unknown as {
        setLabels(labels: Record<string, string>): Promise<unknown>;
        setAutostopInterval(minutes: number): Promise<void>;
      };
      await mutable
        .setLabels({ ...managedSandboxLabels(), 'kortix.piworker-claimed': '1' })
        .catch((err: unknown) =>
          console.warn(`[pi-pool] relabel of claimed ${box.externalId} failed:`, err),
        );
      await mutable
        .setAutostopInterval(providerAutoStopBackstopMinutes())
        .catch((err: unknown) =>
          console.warn(`[pi-pool] autostop reset of claimed ${box.externalId} failed:`, err),
        );
      return {
        externalId: box.externalId,
        baseUrl: `${kortixApiRoot()}/v1/p/${box.externalId}/8000`,
      };
    } catch (err) {
      console.warn(`[pi-pool] claim attempt on ${box.externalId} errored:`, err);
    }
  }
  return null;
}

let maintainInFlight: Promise<void> | null = null;

/**
 * The paginated Daytona list can serve STALE labels: observed live on dev
 * 2026-08-27, a claimed box (park labels correctly replaced — the direct GET
 * proved it) still appeared park-labeled in the list minutes later. A reap
 * decided on that view would delete a LIVE SESSION box. So before any
 * destructive action, re-read the box directly — the direct GET is the
 * authority. A box that no longer carries the park label is simply not ours.
 */
async function verifyStillParked(externalId: string): Promise<boolean> {
  try {
    const sandbox = await withTimeout(
      getDaytona().get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId})`,
    );
    const labels = (sandbox as unknown as { labels?: Record<string, string> }).labels ?? {};
    return labels[PARK_LABEL] === '1';
  } catch {
    // Unknowable ≠ reapable. Skip this round; the next tick retries.
    return false;
  }
}

/**
 * Reconcile the pool toward the target: reap stale-hash / over-age / dead /
 * surplus parked boxes, then create up to MAX_CREATES_PER_MAINTAIN missing
 * ones. Concurrent invocations coalesce; every error is contained (the pool
 * must never take a session create down with it).
 */
export function maintainPiWorkerPool(): Promise<void> {
  if (!piWorkerPoolEnabled()) return Promise.resolve();
  if (maintainInFlight) return maintainInFlight;
  maintainInFlight = (async () => {
    const target = config.KORTIX_PI_WORKER_POOL_TARGET;
    const maxAgeMs = config.KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES * 60_000;
    const image = await ensurePiWorkerImage({ provider: 'daytona' });
    const listed = await listParkedBoxes();
    // Re-verify every listed box against the direct GET (stale-label hazard
    // above). Claimed boxes drop out here instead of polluting the counts.
    const parked: ParkedBox[] = [];
    for (const box of listed) {
      if (await verifyStillParked(box.externalId)) parked.push(box);
    }
    const now = Date.now();
    const alive: ParkedBox[] = [];
    const reap: ParkedBox[] = [];
    for (const box of parked) {
      const state = box.state.toLowerCase();
      const dead = state === 'stopped' || state === 'error' || state === 'destroyed';
      const stale = box.contentHash !== image.contentHash;
      const overAge = box.createdAt !== null && now - box.createdAt.getTime() > maxAgeMs;
      if (dead || stale || overAge || !box.parkToken) reap.push(box);
      else alive.push(box);
    }
    // Surplus (multi-instance refills can overshoot): trim oldest first.
    alive.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    while (alive.length > target) reap.push(alive.shift() as ParkedBox);
    for (const box of reap) {
      await removeBox(box.externalId).catch((err) =>
        console.warn(`[pi-pool] reap of ${box.externalId} failed:`, err),
      );
    }
    const missing = Math.min(Math.max(0, target - alive.length), MAX_CREATES_PER_MAINTAIN);
    for (let i = 0; i < missing; i++) {
      await createParkedBox(image.snapshotName, image.contentHash).catch((err) =>
        console.warn('[pi-pool] parked box create failed:', err),
      );
    }
    if (reap.length > 0 || missing > 0) {
      console.log(
        `[pi-pool] maintained: ${alive.length}/${target} parked, reaped ${reap.length}, created ${missing}`,
      );
    }
  })()
    .catch((err) => console.warn('[pi-pool] maintain failed:', err))
    .finally(() => {
      maintainInFlight = null;
    });
  return maintainInFlight;
}

let maintainTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Leader-only periodic reconcile (index.ts singleton workers). The per-create
 * refill kick keeps the pool moving under load; this interval is the idle
 * safety net (initial fill after deploy, reap of over-age boxes overnight).
 */
export function startPiWorkerPoolMaintenance(): void {
  if (!piWorkerPoolEnabled() || maintainTimer) return;
  void maintainPiWorkerPool();
  maintainTimer = setInterval(() => void maintainPiWorkerPool(), 5 * 60_000);
  (maintainTimer as { unref?: () => void }).unref?.();
}

export function stopPiWorkerPoolMaintenance(): void {
  if (maintainTimer) {
    clearInterval(maintainTimer);
    maintainTimer = null;
  }
}
