/**
 * Kortix Backends lifecycle: one self-hosted Convex backend per persistent
 * Platinum machine.
 *
 * Create is two steps. `insertBackend` claims the name and answers at once.
 * `provisionBackend` then runs in the background (≈3 s on a warm image, up to
 * a few minutes the first time a region builds the image): create the machine
 * with public 3210/3211, write the origins file the supervisor waits for, wait
 * for `/version`, mint the admin key inside the machine, seal it, mark
 * `running`. Any failure marks the row `error` and deletes the machine.
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
 * ponytail: no per-backend budget. The caps (3 per project, 10 per account) and
 * the wallet gate on create and resize bound the spend; add a budget like Apps
 * when a customer runs many backends.
 * ponytail: always on (`persistent`). Platinum does not count an open
 * WebSocket as activity, so idle-stop would cycle every live client; add it
 * once the edge does.
 */

import { randomUUID } from 'node:crypto';
import { projectBackends, projects } from '@kortix/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { oauthIssuer } from '../oauth/discovery';
import { db } from '../shared/db';
import { PlatinumHttpError, platinumJson } from '../shared/platinum';
import { sandboxOwnershipMarker } from '../platform/sandbox-ownership';
import { currentInstanceId, decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import {
  type BackendTokenSubject,
  backendAuthEnv,
  generateBackendAuthKey,
  legacyBackendIssuer,
  mintBackendToken,
  setBackendEnv,
} from './auth';
import {
  CONVEX_API_PORT,
  CONVEX_DASHBOARD_PORT,
  CONVEX_IMAGE_SPEC,
  CONVEX_ORIGINS_FILE,
  CONVEX_SITE_PORT,
} from './convex-image';
import { backendFailureMessage } from './errors';
import { logger } from '../lib/logger';
import { endComputeSession } from '../billing/services/compute-metering';

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

type PlatinumCreated = {
  id: string;
  exposed?: Array<{ port: number; url: string; public: boolean }>;
};
type PlatinumExec = { result?: { stdout?: string; stderr?: string; exit_code?: number }; error?: string };

export type BackendRow = typeof projectBackends.$inferSelect;

export class BackendLimitError extends Error {}

/** A provision or operation writes `metadata.heartbeatAt` this often while it runs. */
export const HEARTBEAT_MS = 20_000;

/** Longer than any real provision, including a first image build. */
export const PROVISION_STALE_MS = 15 * 60_000;

/** The last sign of life of the provision or operation running on this row. */
export function lastHeartbeat(row: Pick<BackendRow, 'metadata' | 'createdAt'>): number {
  const meta = row.metadata as { heartbeatAt?: string; operationStartedAt?: string };
  const at = Date.parse(meta.heartbeatAt ?? meta.operationStartedAt ?? '');
  return Number.isFinite(at) ? at : row.createdAt.getTime();
}

/**
 * The status to show. A provision with no heartbeat for PROVISION_STALE_MS was
 * interrupted and maintenance could not resume it: it reads as `error`.
 */
export function effectiveStatus(row: BackendRow, now = Date.now()): BackendRow['status'] {
  return row.status === 'provisioning' && now - lastHeartbeat(row) > PROVISION_STALE_MS ? 'error' : row.status;
}

/**
 * Writes `metadata.heartbeatAt` every HEARTBEAT_MS until the returned stop is
 * called, so maintenance can tell a running provision or operation from one
 * whose API process died.
 */
export function keepAlive(backendId: string): () => void {
  const beat = () =>
    db
      .update(projectBackends)
      .set({
        metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ heartbeatAt: new Date().toISOString() })}::jsonb`,
      })
      .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
      .catch((error) => logger.warn('[backends] heartbeat failed', { backendId, error: String(error) }));
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function exposedOrigin(created: PlatinumCreated, port: number): string {
  const url = created.exposed?.find((e) => e.port === port)?.url;
  if (!url) throw new Error(`the machine has no public URL for port ${port}`);
  return url.split('?')[0]!.replace(/\/+$/, '');
}

export async function waitHealthy(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/version`, { signal: AbortSignal.timeout(5_000) });
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
    logger.error('[backends] exec failed', {
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
async function verifyAdminKey(url: string, adminKey: string): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/check_admin_key`, {
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
export async function sealAdminKey(row: BackendRow): Promise<void> {
  if (!row.externalId || !row.url) throw new Error('backend has no machine');
  const adminKey = await mintAdminKey(row.externalId);
  await verifyAdminKey(row.url, adminKey);
  await db
    .update(projectBackends)
    .set({ adminKeyEnc: encryptProjectSecret(row.projectId, adminKey), updatedAt: new Date() })
    .where(and(eq(projectBackends.backendId, row.backendId), isNull(projectBackends.deletedAt)));
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
export async function discardMachine(backendId: string, externalId: string | null): Promise<{ machineDeletePending?: true }> {
  if (!externalId) return {};
  try {
    await deleteBackendMachine(externalId);
    return {};
  } catch (error) {
    logger.warn('[backends] machine delete failed; maintenance retries it', { backendId, externalId, error: String(error) });
    return { machineDeletePending: true };
  }
}

export async function listProjectBackends(projectId: string): Promise<BackendRow[]> {
  return db
    .select()
    .from(projectBackends)
    .where(and(eq(projectBackends.projectId, projectId), isNull(projectBackends.deletedAt)))
    .orderBy(asc(projectBackends.createdAt));
}

/** A live (not deleted) backend of this project, or null. */
export async function getLiveBackend(projectId: string, backendId: string): Promise<BackendRow | null> {
  const [row] = await db
    .select()
    .from(projectBackends)
    .where(
      and(
        eq(projectBackends.backendId, backendId),
        eq(projectBackends.projectId, projectId),
        isNull(projectBackends.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The issuer a new backend's tokens carry: the public API origin (KORTIX_URL),
 * where ./discovery.ts serves its OpenID configuration and key set. Stored on
 * the row and never recomputed, so a later KORTIX_URL change moves no backend.
 */
export function newBackendIssuer(backendId: string): string {
  return `${oauthIssuer()}/v1/backends/${backendId}`;
}

/** The issuer this backend's environment expects. */
export function backendIssuer(row: BackendRow): string {
  return row.authIssuer ?? legacyBackendIssuer(row.backendId);
}

/** Mints a Kortix sign-in token for this member, or null when the backend predates sign-in. */
export function backendMemberToken(row: BackendRow, subject: BackendTokenSubject) {
  if (!row.authKeyEnc) return null;
  return mintBackendToken(row.backendId, backendIssuer(row), decryptProjectSecret(row.projectId, row.authKeyEnc), {
    ...subject,
    accountId: row.accountId,
    projectId: row.projectId,
  });
}

/** The public KORTIX_AUTH_* values that verify this backend's tokens, or null when it predates sign-in. */
export function backendPublicAuthEnv(row: BackendRow) {
  if (!row.authKeyEnc) return null;
  const env = backendAuthEnv(row.backendId, backendIssuer(row), decryptProjectSecret(row.projectId, row.authKeyEnc));
  return {
    KORTIX_AUTH_ISSUER: env.KORTIX_AUTH_ISSUER!,
    KORTIX_AUTH_AUDIENCE: env.KORTIX_AUTH_AUDIENCE!,
    KORTIX_AUTH_JWKS: env.KORTIX_AUTH_JWKS!,
  };
}

/** Whether the project has the `backends` flag on. Fail-closed: a missing project is off. */
export async function backendsEnabled(projectId: string): Promise<boolean> {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return Boolean(row) && resolveFeatureFlag(row!.metadata, 'backends');
}

/** A live, running backend of this project by name, or null. */
export async function getRunningBackendByName(projectId: string, name: string): Promise<BackendRow | null> {
  const [row] = await db
    .select()
    .from(projectBackends)
    .where(
      and(
        eq(projectBackends.projectId, projectId),
        eq(projectBackends.name, name),
        eq(projectBackends.status, 'running'),
        isNull(projectBackends.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The admin key of a running backend. */
export function backendAdminKey(row: BackendRow & { adminKeyEnc: string }): string {
  return decryptProjectSecret(row.projectId, row.adminKeyEnc);
}

/**
 * Claims a backend name. The project cap (3) and the account cap (10) are
 * counted and the row is inserted in ONE transaction that holds a per-account
 * advisory lock, so concurrent creates cannot overshoot either cap.
 */
export async function insertBackend(input: {
  projectId: string;
  accountId: string;
  userId: string;
  name: string;
  size?: Partial<BackendSize>;
}): Promise<BackendRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kortix.backends:${input.accountId}`}))`);
    const [counts] = await tx
      .select({
        account: sql<number>`count(*)::int`,
        project: sql<number>`(count(*) filter (where ${projectBackends.projectId} = ${input.projectId}))::int`,
      })
      .from(projectBackends)
      .where(and(eq(projectBackends.accountId, input.accountId), isNull(projectBackends.deletedAt)));
    if ((counts?.project ?? 0) >= MAX_BACKENDS_PER_PROJECT) {
      throw new BackendLimitError(`a project can have at most ${MAX_BACKENDS_PER_PROJECT} backends; delete one first`);
    }
    if ((counts?.account ?? 0) >= MAX_BACKENDS_PER_ACCOUNT) {
      throw new BackendLimitError(
        `an account can have at most ${MAX_BACKENDS_PER_ACCOUNT} backends across its projects; delete one or contact Kortix`,
      );
    }
    // The live-name unique index makes a duplicate name throw here, before any machine exists.
    const backendId = randomUUID();
    const [row] = await tx
      .insert(projectBackends)
      .values({
        backendId,
        authIssuer: newBackendIssuer(backendId),
        projectId: input.projectId,
        accountId: input.accountId,
        name: input.name,
        provider: BACKEND_PROVIDER,
        cpu: input.size?.cpu ?? BACKEND_MACHINE.cpu,
        memoryGb: input.size?.memoryGb ?? BACKEND_MACHINE.memoryGb,
        diskGb: input.size?.diskGb ?? BACKEND_MACHINE.diskGb,
        template: CONVEX_IMAGE_SPEC.base_image,
        createdBy: input.userId,
      })
      .returning();
    return row!;
  });
}

export async function provisionBackend(row: BackendRow, region?: string): Promise<BackendRow> {
  const { backendId, projectId } = row;
  let externalId: string | null = null;
  const stopHeartbeat = keepAlive(backendId);
  try {
    const created = await platinumJson<PlatinumCreated>(
      `/v1/sandboxes?wait_for_state=running&wait_timeout_ms=${CREATE_WAIT_MS}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(CREATE_WAIT_MS + 30_000),
        // The backend id makes a retried create replay the committed machine.
        headers: { 'Idempotency-Key': `kortix-backend-${backendId}` },
        body: JSON.stringify({
          image: CONVEX_IMAGE_SPEC,
          name: `backend-${backendId}`,
          type: 'persistent',
          auto_stop_minutes: 0,
          auto_resume: true,
          cpu: row.cpu,
          ram_mb: row.memoryGb * 1024,
          disk_gb: row.diskGb,
          ...(region ? { region } : {}),
          // Convex clients cannot send Platinum's preview token, so both ports
          // are public; the admin key guards the admin API, as on Convex Cloud.
          expose: [
            { port: CONVEX_API_PORT, public: true },
            { port: CONVEX_SITE_PORT, public: true },
            { port: CONVEX_DASHBOARD_PORT, public: true },
          ],
          metadata: {
            'kortix.managed': await sandboxOwnershipMarker(),
            'kortix.env': config.INTERNAL_KORTIX_ENV,
            'kortix.workload': 'backend',
            'kortix.backend_id': backendId,
            ...(currentInstanceId() ? { 'kortix.instance': currentInstanceId()! } : {}),
          },
        }),
      },
    );
    externalId = created.id;
    await db
      .update(projectBackends)
      .set({ externalId, updatedAt: new Date() })
      .where(eq(projectBackends.backendId, backendId));

    const url = exposedOrigin(created, CONVEX_API_PORT);
    const siteUrl = exposedOrigin(created, CONVEX_SITE_PORT);
    await writeOriginsFile(
      externalId,
      `CONVEX_CLOUD_ORIGIN=${url}\nCONVEX_SITE_ORIGIN=${siteUrl}\nKORTIX_FRAME_ANCESTORS=${dashboardFrameAncestors()}\n`,
    );
    await waitHealthy(url);
    const adminKey = await mintAdminKey(externalId);
    // Kortix sign-in: the backend verifies member tokens with this key's public half.
    const authKey = generateBackendAuthKey();
    await setBackendEnv(url, adminKey, backendAuthEnv(backendId, backendIssuer(row), authKey));

    const [ready] = await db
      .update(projectBackends)
      .set({
        status: 'running',
        url,
        siteUrl,
        adminKeyEnc: encryptProjectSecret(projectId, adminKey),
        authKeyEnc: encryptProjectSecret(projectId, authKey),
        // This machine serves Convex's dashboard on CONVEX_DASHBOARD_PORT.
        metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || '{"dashboard":true}'::jsonb`,
        updatedAt: new Date(),
      })
      // Only a row nobody deleted meanwhile may become `running`.
      .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
      .returning();
    if (!ready) throw new Error('backend was deleted while it was provisioning');
    return ready;
  } catch (error) {
    // The row carries a mapped reason; the provider's raw text stays in the log.
    const message = backendFailureMessage(error);
    const pending = await discardMachine(backendId, externalId);
    await db
      .update(projectBackends)
      .set({ status: 'error', updatedAt: new Date(), metadata: { lastError: message.slice(0, 2_000), ...pending } })
      .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
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
  const rows = await db
    .select()
    .from(projectBackends)
    .where(
      and(
        isNull(projectBackends.authIssuer),
        isNull(projectBackends.deletedAt),
        eq(projectBackends.status, 'running'),
        isNotNull(projectBackends.authKeyEnc),
        isNotNull(projectBackends.adminKeyEnc),
        isNotNull(projectBackends.url),
      ),
    );
  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    const issuer = newBackendIssuer(row.backendId);
    try {
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(projectBackends)
          .set({ authIssuer: issuer, updatedAt: new Date() })
          .where(and(eq(projectBackends.backendId, row.backendId), isNull(projectBackends.authIssuer)))
          .returning({ backendId: projectBackends.backendId });
        if (!claimed) return;
        await setBackendEnv(row.url!, backendAdminKey({ ...row, adminKeyEnc: row.adminKeyEnc! }), {
          KORTIX_AUTH_ISSUER: issuer,
        });
        moved += 1;
      });
    } catch (error) {
      failed += 1;
      logger.warn('[backends] issuer move failed; the backend keeps its old issuer', {
        backendId: row.backendId,
        error: String(error),
      });
    }
  }
  if (rows.length > 0) logger.info('[backends] issuer move', { candidates: rows.length, moved, failed });
  return { moved, failed };
}

/** Delete the machine and its snapshots (its data goes with them), close its meter, then retire the row. */
export async function deleteBackend(row: BackendRow): Promise<void> {
  if (row.externalId) await deleteBackendMachine(row.externalId);
  // The billing invariant sweep closes the window of a deleted backend if this fails.
  await endComputeSession(row.backendId).catch((error) =>
    logger.warn('[backends] could not close the compute window', { backendId: row.backendId, error: String(error) }),
  );
  await db
    .update(projectBackends)
    .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectBackends.backendId, row.backendId));
}
