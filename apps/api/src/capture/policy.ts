/**
 * Capture policy: stored in Postgres, mirrored to the bucket where devices read
 * it (`<prefix>/policy.json`, per-device override `<prefix>/<device_id>/policy.json`).
 * Every write updates the row and the object in one transaction: if the object
 * write fails, the row rolls back, so the database never claims a policy the
 * devices cannot see.
 */
import { captureDevices, capturePolicies } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { DEFAULT_POLICY, PolicySchema, policyDocument, projectPrefix, type CapturePolicy } from './format';
import { captureStore, captureStoreConfigured, putCaptureObject } from './store';

export interface ProjectRef {
  projectId: string;
  accountId: string;
}

export async function readProjectPolicy(
  projectId: string,
): Promise<{ policy: CapturePolicy; updated_at: string | null; updated_by: string | null }> {
  const [row] = await db.select().from(capturePolicies).where(eq(capturePolicies.projectId, projectId)).limit(1);
  if (!row) return { policy: DEFAULT_POLICY, updated_at: null, updated_by: null };
  return {
    policy: PolicySchema.parse(row.policy),
    updated_at: row.updatedAt.toISOString(),
    updated_by: row.updatedBy,
  };
}

/** Store the project policy and publish `<prefix>/policy.json`. */
export async function writeProjectPolicy(project: ProjectRef, policy: CapturePolicy, userId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(capturePolicies)
      .values({ projectId: project.projectId, policy, updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({ target: capturePolicies.projectId, set: { policy, updatedBy: userId, updatedAt: now } });
    await putCaptureObject(
      `${projectPrefix(project.accountId, project.projectId)}/policy.json`,
      policyDocument(policy, now.getTime()),
      'application/json',
    );
  });
  return { policy, updated_at: now.toISOString(), updated_by: userId };
}

/** Store or clear one device's override, and publish or delete its `policy.json`. */
export async function writeDevicePolicy(
  project: ProjectRef,
  deviceId: string,
  policy: CapturePolicy | null,
): Promise<void> {
  const key = `${projectPrefix(project.accountId, project.projectId)}/${deviceId}/policy.json`;
  await db.transaction(async (tx) => {
    await tx
      .update(captureDevices)
      .set({ policyOverride: policy, updatedAt: sql`now()` })
      .where(eq(captureDevices.deviceId, deviceId));
    if (policy) await putCaptureObject(key, policyDocument(policy, Date.now()), 'application/json');
    else await captureStore.remove([key]);
  });
}

/**
 * Make sure `<prefix>/policy.json` exists before a device's first read: a
 * project that never saved a policy still publishes the default. Best effort;
 * a device without a policy object applies its own local settings.
 */
export async function ensurePolicyObject(project: ProjectRef): Promise<void> {
  if (!captureStoreConfigured()) return;
  const key = `${projectPrefix(project.accountId, project.projectId)}/policy.json`;
  try {
    if (await captureStore.head(key)) return;
    const { policy, updated_at } = await readProjectPolicy(project.projectId);
    await putCaptureObject(key, policyDocument(policy, updated_at ? Date.parse(updated_at) : Date.now()), 'application/json');
  } catch (error) {
    logger.warn('[capture] could not publish policy.json', { projectId: project.projectId, error: String(error) });
  }
}
