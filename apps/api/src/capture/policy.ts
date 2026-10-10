/**
 * Capture policy, one per account: stored in the account's workspace row and
 * mirrored to the bucket where devices read it (`orgs/<account_id>/policy.json`,
 * per-device override `orgs/<account_id>/<device_id>/policy.json`). Every write
 * updates the row and the object in one transaction: if the object write
 * fails, the row rolls back, so the database never claims a policy the devices
 * cannot see.
 */
import { captureDevices, captureWorkspaces } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { accountPrefix, policyDocument, type CapturePolicy } from './format';
import { captureStore, captureStoreConfigured, putCaptureObject } from './store';
import { readWorkspace } from './workspace';

export async function readAccountPolicy(
  accountId: string,
): Promise<{ policy: CapturePolicy; updated_at: string | null; updated_by: string | null }> {
  const workspace = await readWorkspace(accountId);
  return {
    policy: workspace.policy,
    updated_at: workspace.updatedAt?.toISOString() ?? null,
    updated_by: workspace.updatedBy,
  };
}

/** Store the account policy and publish `orgs/<account_id>/policy.json`. */
export async function writeAccountPolicy(accountId: string, policy: CapturePolicy, userId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(captureWorkspaces)
      .values({ accountId, policy, updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({ target: captureWorkspaces.accountId, set: { policy, updatedBy: userId, updatedAt: now } });
    await putCaptureObject(`${accountPrefix(accountId)}/policy.json`, policyDocument(policy, now.getTime()), 'application/json');
  });
  return { policy, updated_at: now.toISOString(), updated_by: userId };
}

/** Store or clear one device's override, and publish or delete its `policy.json`. */
export async function writeDevicePolicy(accountId: string, deviceId: string, policy: CapturePolicy | null): Promise<void> {
  const key = `${accountPrefix(accountId)}/${deviceId}/policy.json`;
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
 * Make sure `orgs/<account_id>/policy.json` exists before a device's first
 * read: an account that never saved a policy still publishes the default.
 * Best effort; a device without a policy object applies its own local settings.
 */
export async function ensurePolicyObject(accountId: string): Promise<void> {
  if (!captureStoreConfigured()) return;
  const key = `${accountPrefix(accountId)}/policy.json`;
  try {
    if (await captureStore.head(key)) return;
    const { policy, updated_at } = await readAccountPolicy(accountId);
    await putCaptureObject(key, policyDocument(policy, updated_at ? Date.parse(updated_at) : Date.now()), 'application/json');
  } catch (error) {
    logger.warn('[capture] could not publish policy.json', { accountId, error: String(error) });
  }
}
