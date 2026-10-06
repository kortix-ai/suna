/**
 * Kortix Backends lifecycle: one self-hosted Convex backend per persistent
 * Platinum machine.
 *
 * Create is two steps. `insertBackend` claims the name and answers at once.
 * `provisionBackend` then runs in the background (≈3 s on a warm image, up to
 * a few minutes the first time a region builds the image): create the machine
 * with public 3210/3211, write the origins file the supervisor waits for, wait
 * for `/version`, mint the admin key inside the machine, seal it, mark
 * `running`. Any failure marks the row `error` and deletes the machine. A row
 * left `provisioning` by a process restart reads as `error` after
 * PROVISION_STALE_MS (see `effectiveStatus`).
 *
 * ponytail: not metered. Backends are capped per project while the flag is
 * experimental; compute metering with liveness stamps is the gate to beta.
 * ponytail: always on (`persistent`). Platinum does not count an open
 * WebSocket as activity, so idle-stop would cycle every live client; add it
 * once the edge does.
 */

import { projectBackends } from '@kortix/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { platinumJson } from '../shared/platinum';
import { sandboxOwnershipMarker } from '../platform/sandbox-ownership';
import { currentInstanceId, decryptProjectSecret, encryptProjectSecret } from '../projects/surface';
import {
  CONVEX_API_PORT,
  CONVEX_IMAGE_SPEC,
  CONVEX_ORIGINS_FILE,
  CONVEX_SITE_PORT,
} from './convex-image';

export const BACKEND_PROVIDER = 'platinum';
export const MAX_BACKENDS_PER_PROJECT = 3;
export const BACKEND_MACHINE = { cpu: 1, memoryGb: 1, diskGb: 10 } as const;

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

/** Longer than any real provision, including a first image build. */
export const PROVISION_STALE_MS = 15 * 60_000;

/** The status to show: a provision this old was interrupted, not slow. */
export function effectiveStatus(row: BackendRow, now = Date.now()): BackendRow['status'] {
  return row.status === 'provisioning' && now - row.createdAt.getTime() > PROVISION_STALE_MS
    ? 'error'
    : row.status;
}

function exposedOrigin(created: PlatinumCreated, port: number): string {
  const url = created.exposed?.find((e) => e.port === port)?.url;
  if (!url) throw new Error(`platinum create returned no exposed URL for port ${port}`);
  return url.split('?')[0]!.replace(/\/+$/, '');
}

async function waitHealthy(url: string): Promise<void> {
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

async function mintAdminKey(externalId: string): Promise<string> {
  const out = await platinumJson<PlatinumExec>(`/v1/sandboxes/${externalId}/exec`, {
    method: 'POST',
    signal: AbortSignal.timeout(40_000),
    body: JSON.stringify({ cmd: ['bash', '-c', 'cd /convex && ./generate_admin_key.sh'], timeout_ms: 30_000 }),
  });
  const key = out.result?.stdout?.trim().split('\n').pop()?.trim();
  if (out.error || out.result?.exit_code !== 0 || !key) {
    throw new Error(`admin key generation failed: ${out.error ?? out.result?.stderr ?? 'empty output'}`);
  }
  return key;
}

async function deleteMachine(externalId: string): Promise<void> {
  await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'DELETE' });
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

/** The admin key of a running backend. */
export function backendAdminKey(row: BackendRow & { adminKeyEnc: string }): string {
  return decryptProjectSecret(row.projectId, row.adminKeyEnc);
}

export async function insertBackend(input: {
  projectId: string;
  accountId: string;
  userId: string;
  name: string;
}): Promise<BackendRow> {
  const live = await db
    .select({ id: projectBackends.backendId })
    .from(projectBackends)
    .where(and(eq(projectBackends.projectId, input.projectId), isNull(projectBackends.deletedAt)));
  // ponytail: count-then-insert can overshoot by one under a concurrent create; the cap is a cost guard, not a contract.
  if (live.length >= MAX_BACKENDS_PER_PROJECT) {
    throw new BackendLimitError(`a project can have at most ${MAX_BACKENDS_PER_PROJECT} backends`);
  }

  // The live-name unique index makes a duplicate name throw here, before any machine exists.
  const [row] = await db
    .insert(projectBackends)
    .values({
      projectId: input.projectId,
      accountId: input.accountId,
      name: input.name,
      provider: BACKEND_PROVIDER,
      cpu: BACKEND_MACHINE.cpu,
      memoryGb: BACKEND_MACHINE.memoryGb,
      diskGb: BACKEND_MACHINE.diskGb,
      template: CONVEX_IMAGE_SPEC.base_image,
      createdBy: input.userId,
    })
    .returning();
  return row!;
}

export async function provisionBackend(row: BackendRow, region?: string): Promise<BackendRow> {
  const { backendId, projectId } = row;
  let externalId: string | null = null;
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
          cpu: BACKEND_MACHINE.cpu,
          ram_mb: BACKEND_MACHINE.memoryGb * 1024,
          disk_gb: BACKEND_MACHINE.diskGb,
          ...(region ? { region } : {}),
          // Convex clients cannot send Platinum's preview token, so both ports
          // are public; the admin key guards the admin API, as on Convex Cloud.
          expose: [
            { port: CONVEX_API_PORT, public: true },
            { port: CONVEX_SITE_PORT, public: true },
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
    await platinumJson(`/v1/sandboxes/${externalId}/files?path=${encodeURIComponent(CONVEX_ORIGINS_FILE)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: `CONVEX_CLOUD_ORIGIN=${url}\nCONVEX_SITE_ORIGIN=${siteUrl}\n`,
    });
    await waitHealthy(url);
    const adminKey = await mintAdminKey(externalId);

    const [ready] = await db
      .update(projectBackends)
      .set({
        status: 'running',
        url,
        siteUrl,
        adminKeyEnc: encryptProjectSecret(projectId, adminKey),
        updatedAt: new Date(),
      })
      // Only a row nobody deleted meanwhile may become `running`.
      .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
      .returning();
    if (!ready) throw new Error('backend was deleted while it was provisioning');
    return ready;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (externalId) await deleteMachine(externalId).catch(() => {});
    await db
      .update(projectBackends)
      .set({ status: 'error', updatedAt: new Date(), metadata: { lastError: message.slice(0, 2_000) } })
      .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt)))
      .catch(() => {});
    throw error;
  }
}

/** Delete the machine (its data goes with it), then retire the row. */
export async function deleteBackend(row: BackendRow): Promise<void> {
  if (row.externalId) {
    await deleteMachine(row.externalId).catch((err) => {
      // An already-deleted machine is the goal state.
      if (!(err instanceof Error && / -> 404 /.test(err.message))) throw err;
    });
  }
  await db
    .update(projectBackends)
    .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectBackends.backendId, row.backendId));
}
