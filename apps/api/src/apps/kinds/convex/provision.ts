/**
 * The machine of an App of kind `convex`: one self-hosted Convex backend per
 * persistent Platinum machine. The App row (`apps`) holds the shared fields
 * (slug, name, size, budget, access, deletion); `app_convex_instances` holds
 * the machine. A `ConvexRow` is the two joined.
 *
 * Create is two steps. `insertConvexApp` claims the slug and answers at once.
 * `provisionBackend` then runs in the background (≈3 s on a warm image, up to
 * a few minutes the first time a region builds the image): create the machine
 * with 3210/3211/6791 exposed PRIVATELY, write the origins file the supervisor
 * waits for (the backend's Kortix hosts, ./hosts.ts), wait for `/version`,
 * mint the admin key inside the machine, seal it, mark `running`. Any failure
 * marks the row `error` and deletes the machine. Kortix reaches the machine
 * only through Platinum's private exposure (./machine.ts); clients reach it
 * only through the Kortix hosts.
 *
 * A provision writes `metadata.heartbeatAt` every HEARTBEAT_MS. One whose
 * heartbeat stops (the API process died: a deploy, an OOM) is resumed by
 * maintenance (./maintenance.ts): it replays the create with the same
 * Idempotency-Key, so Platinum returns the same machine, and every later step
 * is safe to repeat.
 *
 * Billing: a running machine is metered like a sandbox, reserved spec × wall
 * clock (workload_type `backend`); ./maintenance.ts opens the window and
 * records liveness. Snapshot storage is not billed yet.
 * The App's monthly budget alerts at 80 % and 100 % and never stops the machine
 * (./maintenance.ts budgetAlerts): a stopped database breaks every client.
 * The caps (3 per project, 10 per account) and the wallet gate on create and
 * resize bound the spend.
 * ponytail: always on (`persistent`). Platinum does not count an open
 * WebSocket as activity, so idle-stop would cycle every live client; add it
 * once the edge does.
 */

import { randomBytes } from 'node:crypto';
import { appConvexInstances, apps } from '@kortix/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type ConvexRow, liveConvexApp, liveInstance, selectConvexRows } from './rows';

export { CONVEX_ROW, type ConvexRow, liveConvexApp, liveInstance, selectConvexRows } from './rows';
import { config } from '../../../config';
import { oauthIssuer } from '../../../oauth/discovery';
import { db } from '../../../shared/db';
import { PlatinumHttpError, platinumJson } from '../../../shared/platinum';
import { sandboxOwnershipMarker } from '../../../platform/sandbox-ownership';
import { currentInstanceId, decryptProjectSecret, encryptProjectSecret } from '../../../projects/surface';
import {
  type BackendTokenSubject,
  backendAuthEnv,
  generateBackendAuthKey,
  legacyBackendIssuer,
  mintBackendToken,
} from './auth';
import {
  CONVEX_API_PORT,
  CONVEX_DASHBOARD_PORT,
  CONVEX_IMAGE_SPEC,
  CONVEX_ORIGINS_FILE,
  CONVEX_SITE_PORT,
} from './convex-image';
import { backendFailureMessage } from './errors';
import { backendPublicUrls } from './hosts';
import { backendIngress, machineFetch } from './machine';
import { logger } from '../../../lib/logger';
import { endComputeSession } from '../../../billing/services/compute-metering';

export const BACKEND_PROVIDER = 'platinum';
export const MAX_BACKENDS_PER_PROJECT = 3;
/** A cost guard across all of an account's projects. Kortix raises it on request. */
export const MAX_BACKENDS_PER_ACCOUNT = 10;
export const BACKEND_MACHINE = { cpu: 1, memoryGb: 1, diskGb: 10 } as const;
/** Platinum's per-machine ceilings (POST /v1/sandboxes/:id/resize). Disk only grows. */
export const BACKEND_MACHINE_LIMITS = {
  cpu: { min: 1, max: 16 },
  memoryGb: { min: 1, max: 32 },
  diskGb: { min: 10, max: 100 },
} as const;
export type BackendSize = { cpu: number; memoryGb: number; diskGb: number };

/** First build of the image in a region runs inside the create call. */
const CREATE_WAIT_MS = 10 * 60_000;
const HEALTH_WAIT_MS = 60_000;

type PlatinumCreated = { id: string };
type PlatinumExec = { result?: { stdout?: string; stderr?: string; exit_code?: number }; error?: string };

/** A `convex` App create refused before any machine exists (a cap, a size): 409 or 400 with `code`. */
export class BackendLimitError extends Error {
  constructor(message: string, readonly code = 'app_kind_limit', readonly status: 400 | 409 = 409) {
    super(message);
  }
}

/** A provision or operation writes `metadata.heartbeatAt` this often while it runs. */
export const HEARTBEAT_MS = 20_000;

/** Longer than any real provision, including a first image build. */
export const PROVISION_STALE_MS = 15 * 60_000;

/** The last sign of life of the provision or operation running on this row. */
export function lastHeartbeat(row: Pick<ConvexRow, 'metadata' | 'createdAt'>): number {
  const meta = row.metadata as { heartbeatAt?: string; operationStartedAt?: string };
  const at = Date.parse(meta.heartbeatAt ?? meta.operationStartedAt ?? '');
  return Number.isFinite(at) ? at : row.createdAt.getTime();
}

/**
 * The status to show. A provision with no heartbeat for PROVISION_STALE_MS was
 * interrupted and maintenance could not resume it: it reads as `error`.
 */
export function effectiveStatus(row: ConvexRow, now = Date.now()): ConvexRow['status'] {
  return row.status === 'provisioning' && now - lastHeartbeat(row) > PROVISION_STALE_MS ? 'error' : row.status;
}

/**
 * Writes `metadata[field]` (default `heartbeatAt`) every HEARTBEAT_MS until the
 * returned stop is called, so maintenance can tell a running provision,
 * operation or delete from one whose API process died.
 */
export function keepAlive(appId: string, field: 'heartbeatAt' | 'deleting' = 'heartbeatAt'): () => void {
  const beat = () =>
    db
      .update(appConvexInstances)
      .set({
        metadata: sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) || ${JSON.stringify({ [field]: new Date().toISOString() })}::jsonb`,
      })
      .where(and(eq(appConvexInstances.appId, appId), liveInstance()))
      .catch((error) => logger.warn('[apps:convex] heartbeat failed', { appId, error: String(error) }));
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The ports a backend machine serves. Each is exposed privately: only Kortix holds the edge token. */
export const BACKEND_PORTS = [CONVEX_API_PORT, CONVEX_SITE_PORT, CONVEX_DASHBOARD_PORT] as const;

export async function waitHealthy(externalId: string): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await machineFetch(externalId, CONVEX_API_PORT, '/version', { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not become healthy within ${HEALTH_WAIT_MS / 1000}s (${last})`);
}

/** Runs a bash script in the backend machine. Returns stdout; throws on a non-zero exit. */
export async function execInBackend(externalId: string, script: string, timeoutMs = 30_000): Promise<string> {
  const out = await platinumJson<PlatinumExec>(`/v1/sandboxes/${externalId}/exec`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs + 10_000),
    body: JSON.stringify({ cmd: ['bash', '-c', script], timeout_ms: timeoutMs }),
  });
  if (out.error || out.result?.exit_code !== 0) {
    logger.error('[apps:convex] exec failed', {
      externalId,
      error: out.error ?? out.result?.stderr?.slice(0, 2_000) ?? `exit ${out.result?.exit_code}`,
    });
    throw new Error('a command in the backend machine failed');
  }
  return out.result?.stdout ?? '';
}

/** Derives the admin key from the machine's current instance secret. */
async function mintAdminKey(externalId: string): Promise<string> {
  const key = (await execInBackend(externalId, 'cd /convex && ./generate_admin_key.sh')).trim().split('\n').pop()?.trim();
  if (!key) throw new Error('the backend could not create its admin key');
  return key;
}

/** Convex answers 200 once it accepts the key. Polled: Convex can answer /version before it serves admin routes. */
async function verifyAdminKey(externalId: string, adminKey: string): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await machineFetch(externalId, CONVEX_API_PORT, '/api/check_admin_key', {
        headers: { Authorization: `Convex ${adminKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the backend did not accept its new admin key (${last})`);
}

/**
 * Mints the admin key the running machine accepts now, checks that Convex
 * takes it, and seals it on the row. Needed after anything that can change the
 * instance secret: a rotation, a snapshot restore, a backup restore.
 */
export async function sealAdminKey(row: ConvexRow): Promise<void> {
  if (!row.externalId || !row.url) throw new Error('backend has no machine');
  const adminKey = await mintAdminKey(row.externalId);
  await verifyAdminKey(row.externalId, adminKey);
  await db
    .update(appConvexInstances)
    .set({ adminKeyEnc: encryptProjectSecret(row.projectId, adminKey), updatedAt: new Date() })
    .where(and(eq(appConvexInstances.appId, row.appId), liveInstance()));
}

/**
 * The supervisor waits for this file, so it must survive a crash: the guest
 * rootfs has no ext4 journal (kortix-ai/platinum#1450) and an in-place write
 * can come back empty after a hard reset. `/files/atomic` fsyncs a temp file
 * and renames it. A control plane without that route answers 404.
 */
/** Only Kortix web may frame a backend's dashboard (CSP frame-ancestors). */
function dashboardFrameAncestors(): string {
  return new URL(config.FRONTEND_URL).origin;
}

/** Sets deployment environment variables through the backend's admin API (what `npx convex env set` calls). */
export async function setBackendEnv(externalId: string, adminKey: string, env: Record<string, string>): Promise<void> {
  const res = await machineFetch(externalId, CONVEX_API_PORT, '/api/update_environment_variables', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Convex ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: Object.entries(env).map(([name, value]) => ({ name, value })) }),
  });
  if (!res.ok) throw new Error(`setting backend environment failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/**
 * What the supervisor exports before it starts Convex. CONVEX_CLOUD_ORIGIN and
 * CONVEX_SITE_ORIGIN become `--convex-origin` / `--convex-site`: the URLs
 * Convex puts in file storage URLs and in `process.env.CONVEX_CLOUD_URL` /
 * `CONVEX_SITE_URL`. They are the backend's Kortix hosts.
 */
export function backendOriginsFile(appId: string): string {
  const { url, siteUrl } = backendPublicUrls(appId);
  return `CONVEX_CLOUD_ORIGIN=${url}\nCONVEX_SITE_ORIGIN=${siteUrl}\nKORTIX_FRAME_ANCESTORS=${dashboardFrameAncestors()}\n`;
}

/**
 * Restarts the supervisor when the running Convex has other origins than
 * `want`; prints `unchanged` or `restarted`. The supervisor reads the origins
 * file once at start, so restarting Convex alone keeps the old ones. pt-init
 * (PID 1) only reaps the old supervisor; a new one is started in its own
 * session. Convex is down for about a second. Every pattern is written so it
 * cannot match this script's own `bash -c` command line.
 */
export function restartWithOriginsScript(want: string): string {
  if (!/^https?:\/\/[a-z0-9.:-]+$/.test(want)) throw new Error('invalid backend origin');
  return `set -e
p='^\\./convex-local-backend '
pid=$(pgrep -f "$p" | head -n 1 || true)
if [ -n "$pid" ] && tr '\\0' ' ' < /proc/$pid/cmdline | grep -qF -- '--convex-origin ${want} '; then echo unchanged; exit 0; fi
pkill -9 -f '^/bin/bash /usr/local/bin/[c]onvex-sup' || true
pkill -f "$p" || true
pkill -f '[c]onvex-dashboard-server' || true
for i in $(seq 150); do
  pgrep -f "$p" > /dev/null || break
  if [ "$i" = 100 ]; then pkill -9 -f "$p" || true; fi
  sleep 0.1
done
sup=/usr/local/bin/convex
setsid nohup "$sup-sup" < /dev/null > /dev/null 2>&1 &
for i in $(seq 300); do
  if curl -fsS http://127.0.0.1:${CONVEX_API_PORT}/version > /dev/null 2>&1; then echo restarted; exit 0; fi
  sleep 0.1
done
echo 'convex did not come back' >&2
exit 1`;
}

/**
 * Points the running Convex at the backend's Kortix hosts: writes the origins
 * file, then restarts the supervisor if Convex still runs with other origins.
 * Idempotent: a backend already on its hosts costs one exec and no restart.
 * Runs after the move to the hosts, and after anything that can bring back an
 * older disk or memory image (a snapshot restore, a backup restore, a start).
 */
export async function applyBackendOrigins(row: ConvexRow): Promise<'unchanged' | 'restarted'> {
  if (!row.externalId) throw new Error('backend has no machine');
  await writeOriginsFile(row.externalId, backendOriginsFile(row.appId));
  const out = await execInBackend(row.externalId, restartWithOriginsScript(backendPublicUrls(row.appId).url), 45_000);
  return out.trim().endsWith('restarted') ? 'restarted' : 'unchanged';
}

/**
 * Moves a backend created before the Kortix hosts onto them: Convex gets the
 * new origins, every port becomes private, and the row stores the new URLs.
 * The machine's Platinum URLs answer only with Kortix's token from then on.
 * Safe to repeat. The caller holds the operation lock.
 */
export async function moveBackendToKortixHosts(row: ConvexRow): Promise<void> {
  if (!row.externalId) throw new Error('backend has no machine');
  const result = await applyBackendOrigins(row);
  for (const port of BACKEND_PORTS) await backendIngress(row.externalId, port);
  const { url, siteUrl } = backendPublicUrls(row.appId);
  await db
    .update(appConvexInstances)
    .set({ url, siteUrl, updatedAt: new Date() })
    .where(and(eq(appConvexInstances.appId, row.appId), liveInstance()));
  logger.info('[apps:convex] moved to the Kortix hosts', { appId: row.appId, convex: result });
}

async function writeOriginsFile(externalId: string, body: string): Promise<void> {
  const write = (route: string) =>
    platinumJson(`/v1/sandboxes/${externalId}/${route}?path=${encodeURIComponent(CONVEX_ORIGINS_FILE)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
  try {
    await write('files/atomic');
  } catch (err) {
    if (!(err instanceof PlatinumHttpError && err.status === 404 && !err.body.includes('sandbox_not_found'))) throw err;
    await write('files');
  }
}

/** Platinum answered 404: the machine or snapshot is already gone, the goal of a delete. */
function alreadyGone(error: unknown): boolean {
  return error instanceof PlatinumHttpError && error.status === 404;
}

/**
 * Deletes every snapshot of the machine, then the machine. Platinum's sandbox
 * DELETE tombstones the sandbox and leaves its snapshot rows and images, so the
 * snapshots go first. Anything already gone counts as deleted.
 */
export async function deleteBackendMachine(externalId: string): Promise<void> {
  const snapshots = await platinumJson<Array<{ id: string }>>(`/v1/sandboxes/${externalId}/snapshots`).catch((error) => {
    if (alreadyGone(error)) return [];
    throw error;
  });
  for (const snapshot of snapshots) {
    await platinumJson(`/v1/sandboxes/${externalId}/snapshots/${snapshot.id}`, { method: 'DELETE' }).catch((error) => {
      if (!alreadyGone(error)) throw error;
    });
  }
  await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'DELETE' }).catch((error) => {
    if (!alreadyGone(error)) throw error;
  });
}

/**
 * Deletes a machine that a failed provision leaves behind. A failed delete
 * returns `{ machineDeletePending: true }` for the row's metadata, and
 * maintenance retries it every tick.
 */
export async function discardMachine(appId: string, externalId: string | null): Promise<{ machineDeletePending?: true }> {
  if (!externalId) return {};
  try {
    await deleteBackendMachine(externalId);
    return {};
  } catch (error) {
    logger.warn('[apps:convex] machine delete failed; maintenance retries it', { appId, externalId, error: String(error) });
    return { machineDeletePending: true };
  }
}

/** The live `convex` App with this id in this project, or null. */
export async function getLiveConvexApp(projectId: string, appId: string): Promise<ConvexRow | null> {
  const [row] = await selectConvexRows()
    .where(and(eq(appConvexInstances.appId, appId), eq(apps.projectId, projectId), liveConvexApp()))
    .limit(1);
  return row ?? null;
}

/** The machine rows of these Apps (any state), by App id: one query for an App list. */
export async function convexRowsByAppId(appIds: string[]): Promise<Map<string, ConvexRow>> {
  if (appIds.length === 0) return new Map();
  const rows = await selectConvexRows().where(inArray(appConvexInstances.appId, appIds));
  return new Map(rows.map((row) => [row.appId, row]));
}

/**
 * The issuer a new App's tokens carry: the public API origin (KORTIX_URL),
 * where ./discovery.ts serves its OpenID configuration and key set. Stored on
 * the row and never recomputed, so a later KORTIX_URL change moves no App.
 */
export function newBackendIssuer(appId: string): string {
  return `${oauthIssuer()}/v1/backends/${appId}`;
}

/** The issuer this App's environment expects. */
export function backendIssuer(row: ConvexRow): string {
  return row.authIssuer ?? legacyBackendIssuer(row.appId);
}

/** Mints a Kortix sign-in token for this member, or null when the App predates sign-in. */
export function backendMemberToken(row: ConvexRow, subject: BackendTokenSubject) {
  if (!row.authKeyEnc) return null;
  return mintBackendToken(row.appId, backendIssuer(row), decryptProjectSecret(row.projectId, row.authKeyEnc), {
    ...subject,
    accountId: row.accountId,
    projectId: row.projectId,
  });
}

/** The public KORTIX_AUTH_* values that verify this App's tokens, or null when it predates sign-in. */
export function backendPublicAuthEnv(row: ConvexRow) {
  if (!row.authKeyEnc) return null;
  const env = backendAuthEnv(row.appId, backendIssuer(row), decryptProjectSecret(row.projectId, row.authKeyEnc));
  return {
    KORTIX_AUTH_ISSUER: env.KORTIX_AUTH_ISSUER!,
    KORTIX_AUTH_AUDIENCE: env.KORTIX_AUTH_AUDIENCE!,
    KORTIX_AUTH_JWKS: env.KORTIX_AUTH_JWKS!,
  };
}

/** The admin key of a running App. */
export function backendAdminKey(row: ConvexRow & { adminKeyEnc: string }): string {
  return decryptProjectSecret(row.projectId, row.adminKeyEnc);
}

export interface NewConvexApp {
  projectId: string;
  accountId: string;
  userId: string;
  slug: string;
  name: string;
  size?: Partial<BackendSize>;
  monthlyBudgetUsd: string;
  monthlyBudgetExplicit: boolean;
}

/** The size a new `convex` App gets: the request, else BACKEND_MACHINE, inside BACKEND_MACHINE_LIMITS. */
export function newConvexSize(size: Partial<BackendSize> = {}): BackendSize {
  const next = {
    cpu: size.cpu ?? BACKEND_MACHINE.cpu,
    memoryGb: size.memoryGb ?? BACKEND_MACHINE.memoryGb,
    diskGb: size.diskGb ?? BACKEND_MACHINE.diskGb,
  };
  for (const key of ['cpu', 'memoryGb', 'diskGb'] as const) {
    const { min, max } = BACKEND_MACHINE_LIMITS[key];
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) {
      throw new BackendLimitError(`${key} must be an integer from ${min} to ${max}`, 'invalid_size', 400);
    }
  }
  return next;
}

/**
 * Claims the slug: inserts the App (kind `convex`, always on) and its machine
 * row. The project cap (3) and the account cap (10) are counted and both rows
 * inserted in ONE transaction that holds a per-account advisory lock, so
 * concurrent creates cannot overshoot either cap. A taken slug throws the
 * unique violation (23505) before any machine exists.
 */
export async function insertConvexApp(input: NewConvexApp): Promise<{ app: typeof apps.$inferSelect; row: ConvexRow }> {
  const size = newConvexSize(input.size);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kortix.apps.convex:${input.accountId}`}))`);
    const [counts] = await tx
      .select({
        account: sql<number>`count(*)::int`,
        project: sql<number>`(count(*) filter (where ${apps.projectId} = ${input.projectId}))::int`,
      })
      .from(apps)
      .where(and(eq(apps.accountId, input.accountId), eq(apps.kind, 'convex'), isNull(apps.deletedAt)));
    if ((counts?.project ?? 0) >= MAX_BACKENDS_PER_PROJECT) {
      throw new BackendLimitError(`a project can have at most ${MAX_BACKENDS_PER_PROJECT} backend Apps; delete one first`);
    }
    if ((counts?.account ?? 0) >= MAX_BACKENDS_PER_ACCOUNT) {
      throw new BackendLimitError(
        `an account can have at most ${MAX_BACKENDS_PER_ACCOUNT} backend Apps across its projects; delete one or contact Kortix`,
      );
    }
    const [app] = await tx
      .insert(apps)
      .values({
        accountId: input.accountId,
        projectId: input.projectId,
        slug: input.slug,
        name: input.name,
        kind: 'convex',
        routeKey: randomBytes(8).toString('hex'),
        createdBy: input.userId,
        cpuCores: size.cpu,
        memoryGb: size.memoryGb,
        diskGb: size.diskGb,
        alwaysOn: true,
        monthlyBudgetUsd: input.monthlyBudgetUsd,
        monthlyBudgetExplicit: input.monthlyBudgetExplicit,
      })
      .returning();
    const [instance] = await tx
      .insert(appConvexInstances)
      .values({
        appId: app!.appId,
        authIssuer: newBackendIssuer(app!.appId),
        provider: BACKEND_PROVIDER,
        template: CONVEX_IMAGE_SPEC.base_image,
      })
      .returning();
    return {
      app: app!,
      row: {
        ...instance!,
        projectId: app!.projectId,
        accountId: app!.accountId,
        slug: app!.slug,
        cpu: app!.cpuCores,
        memoryGb: app!.memoryGb,
        diskGb: app!.diskGb,
        monthlyBudgetUsd: app!.monthlyBudgetUsd,
        deletedAt: null,
      },
    };
  });
}

export async function provisionBackend(row: ConvexRow, region?: string): Promise<ConvexRow> {
  const { appId, projectId } = row;
  let externalId: string | null = null;
  const stopHeartbeat = keepAlive(appId);
  try {
    const created = await platinumJson<PlatinumCreated>(
      `/v1/sandboxes?wait_for_state=running&wait_timeout_ms=${CREATE_WAIT_MS}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(CREATE_WAIT_MS + 30_000),
        // The App id makes a retried create replay the committed machine.
        headers: { 'Idempotency-Key': `kortix-backend-${appId}` },
        body: JSON.stringify({
          image: CONVEX_IMAGE_SPEC,
          name: `backend-${appId}`,
          type: 'persistent',
          auto_stop_minutes: 0,
          auto_resume: true,
          cpu: row.cpu,
          ram_mb: row.memoryGb * 1024,
          disk_gb: row.diskGb,
          ...(region ? { region } : {}),
          // Private: Platinum's edge wants Kortix's token. Clients use the
          // Kortix hosts, which the API proxies (./hosts.ts).
          expose: BACKEND_PORTS.map((port) => ({ port, public: false })),
          metadata: {
            'kortix.managed': await sandboxOwnershipMarker(),
            'kortix.env': config.INTERNAL_KORTIX_ENV,
            'kortix.workload': 'backend',
            // The orphan reaper matches machines to Apps by this id (./lifecycle.ts).
            'kortix.backend_id': appId,
            ...(currentInstanceId() ? { 'kortix.instance': currentInstanceId()! } : {}),
          },
        }),
      },
    );
    externalId = created.id;
    await db
      .update(appConvexInstances)
      .set({ externalId, updatedAt: new Date() })
      .where(eq(appConvexInstances.appId, appId));

    const { url, siteUrl } = backendPublicUrls(appId);
    await writeOriginsFile(externalId, backendOriginsFile(appId));
    await waitHealthy(externalId);
    const adminKey = await mintAdminKey(externalId);
    // Kortix sign-in: the backend verifies member tokens with this key's public half.
    const authKey = generateBackendAuthKey();
    await setBackendEnv(externalId, adminKey, backendAuthEnv(appId, backendIssuer(row), authKey));

    const [ready] = await db
      .update(appConvexInstances)
      .set({
        status: 'running',
        url,
        siteUrl,
        adminKeyEnc: encryptProjectSecret(projectId, adminKey),
        authKeyEnc: encryptProjectSecret(projectId, authKey),
        // This machine serves Convex's dashboard on CONVEX_DASHBOARD_PORT.
        metadata: sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) || '{"dashboard":true}'::jsonb`,
        updatedAt: new Date(),
      })
      // Only a row nobody deleted meanwhile may become `running`.
      .where(and(eq(appConvexInstances.appId, appId), liveInstance()))
      .returning();
    if (!ready) throw new Error('the App was deleted while it was provisioning');
    return { ...row, ...ready };
  } catch (error) {
    // The row carries a mapped reason; the provider's raw text stays in the log.
    const message = backendFailureMessage(error);
    const pending = await discardMachine(appId, externalId);
    await db
      .update(appConvexInstances)
      .set({ status: 'error', updatedAt: new Date(), metadata: { lastError: message.slice(0, 2_000), ...pending } })
      .where(and(eq(appConvexInstances.appId, appId), liveInstance()))
      .catch(() => {});
    throw error;
  } finally {
    stopHeartbeat();
  }
}

/**
 * Moves every running backend still on the placeholder issuer to its real one.
 * Convex re-reads `auth.config.ts` when an environment variable changes (no
 * redeploy; verified on CONVEX_BACKEND_IMAGE), so from the env write on, the
 * backend accepts only new-issuer tokens. A token minted before it gets 401;
 * Convex clients then fetch a fresh token, which carries the new issuer.
 *
 * The row is claimed and the env written in one transaction: a failed env
 * write rolls the claim back, and the backend keeps working on the old issuer.
 * One backend at a time, so the pass holds one pooled connection.
 *
 * ponytail: runs once per leadership term (bootstrap). A backend that was
 * unreachable then moves on the next deploy; it works on the old issuer meanwhile.
 */
export async function moveBackendIssuers(): Promise<{ moved: number; failed: number }> {
  const rows = await selectConvexRows().where(
    and(
      isNull(appConvexInstances.authIssuer),
      liveConvexApp(),
      eq(appConvexInstances.status, 'running'),
      isNotNull(appConvexInstances.authKeyEnc),
      isNotNull(appConvexInstances.adminKeyEnc),
      isNotNull(appConvexInstances.externalId),
    ),
  );
  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    const issuer = newBackendIssuer(row.appId);
    try {
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(appConvexInstances)
          .set({ authIssuer: issuer, updatedAt: new Date() })
          .where(and(eq(appConvexInstances.appId, row.appId), isNull(appConvexInstances.authIssuer)))
          .returning({ appId: appConvexInstances.appId });
        if (!claimed) return;
        await setBackendEnv(row.externalId!, backendAdminKey({ ...row, adminKeyEnc: row.adminKeyEnc! }), {
          KORTIX_AUTH_ISSUER: issuer,
        });
        moved += 1;
      });
    } catch (error) {
      failed += 1;
      logger.warn('[apps:convex] issuer move failed; the backend keeps its old issuer', {
        appId: row.appId,
        error: String(error),
      });
    }
  }
  if (rows.length > 0) logger.info('[apps:convex] issuer move', { candidates: rows.length, moved, failed });
  return { moved, failed };
}

/**
 * Deletes the machine and its snapshots (its data goes with them), closes its
 * meter, then removes the machine row. The App row stays deleted.
 */
export async function deleteBackend(row: ConvexRow): Promise<void> {
  if (row.externalId) await deleteBackendMachine(row.externalId);
  // The billing invariant sweep closes the window of a deleted App if this fails.
  await endComputeSession(row.appId).catch((error) =>
    logger.warn('[apps:convex] could not close the compute window', { appId: row.appId, error: String(error) }),
  );
  await db.transaction(async (tx) => {
    await tx
      .update(apps)
      .set({ deletedAt: row.deletedAt ?? new Date(), desiredState: 'stopped', updatedAt: new Date() })
      .where(eq(apps.appId, row.appId));
    await tx.delete(appConvexInstances).where(eq(appConvexInstances.appId, row.appId));
  });
}
