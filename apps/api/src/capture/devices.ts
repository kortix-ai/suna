/**
 * Capture device sign-in (RFC 8628) and device tokens: the data side of
 * device-routes.ts. One device row per (project, machine_key_sha256, member);
 * signing in again revives that row (same device_id, same S3 folder) and
 * replaces its token. A token is stored only as `hashSecretKey(token)`.
 */
import { captureDeviceGrants, captureDevices, projects } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { generateDeviceCode, hashSecretKey, randomAlphanumeric } from '../shared/crypto';
import { db } from '../shared/db';
import { deviceFields, projectPrefix } from './format';

export const GRANT_TTL_MS = 15 * 60_000;
/** RFC 8628 §3.2 default. A poll faster than this answers `slow_down`. */
export const POLL_INTERVAL_S = 5;
export const DEVICE_TOKEN_PREFIX = 'kortix_cap_';

export type Grant = typeof captureDeviceGrants.$inferSelect;
export type Device = typeof captureDevices.$inferSelect;

export interface GrantView {
  user_code: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  expires_at: string;
  device: { name: string | null; os: string | null; os_version: string | null; arch: string | null; app_version: string | null };
  project_id: string | null;
  device_id: string | null;
}

export function grantView(grant: Grant): GrantView {
  const fields = deviceFields(grant.deviceInfo);
  return {
    user_code: grant.userCode,
    status: (grant.status === 'pending' && grant.expiresAt.getTime() < Date.now() ? 'expired' : grant.status) as GrantView['status'],
    expires_at: grant.expiresAt.toISOString(),
    device: { name: fields.name, os: fields.os, os_version: fields.osVersion, arch: fields.arch, app_version: fields.appVersion },
    project_id: grant.projectId,
    device_id: grant.deviceId,
  };
}

/** Start a sign-in. The user code has a unique index: retry the rare collision. */
export async function startDeviceGrant(machineKey: string, deviceInfo: Record<string, string>) {
  const deviceCode = randomAlphanumeric(43);
  const expiresAt = new Date(Date.now() + GRANT_TTL_MS);
  for (let attempt = 0; ; attempt++) {
    const userCode = generateDeviceCode();
    try {
      await db.insert(captureDeviceGrants).values({
        deviceCodeHash: hashSecretKey(deviceCode),
        userCode,
        machineKeySha256: machineKey,
        deviceInfo,
        expiresAt,
      });
      return { deviceCode, userCode, expiresAt };
    } catch (error) {
      if ((error as { code?: string }).code !== '23505' || attempt === 4) throw error;
    }
  }
}

export type PollOutcome =
  | { kind: 'invalid_grant' | 'access_denied' | 'expired_token' | 'slow_down' | 'authorization_pending' }
  | { kind: 'token'; token: string; prefix: string; deviceId: string; userId: string };

/** RFC 8628 §3.4: the device polls with its device code. An approved grant mints the token exactly once. */
export async function pollDeviceGrant(deviceCode: string): Promise<PollOutcome> {
  const [grant] = await db
    .select()
    .from(captureDeviceGrants)
    .where(eq(captureDeviceGrants.deviceCodeHash, hashSecretKey(deviceCode)))
    .limit(1);
  if (!grant || grant.status === 'consumed') return { kind: 'invalid_grant' };
  if (grant.status === 'denied') return { kind: 'access_denied' };
  if (grant.expiresAt.getTime() < Date.now()) return { kind: 'expired_token' };
  if (grant.status === 'pending') {
    const tooSoon = grant.lastPolledAt && Date.now() - grant.lastPolledAt.getTime() < POLL_INTERVAL_S * 1000;
    await db.update(captureDeviceGrants).set({ lastPolledAt: sql`now()` }).where(eq(captureDeviceGrants.grantId, grant.grantId));
    return { kind: tooSoon ? 'slow_down' : 'authorization_pending' };
  }
  const token = `${DEVICE_TOKEN_PREFIX}${randomAlphanumeric(40)}`;
  const device = await db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(captureDeviceGrants)
      .set({ status: 'consumed' })
      .where(and(eq(captureDeviceGrants.grantId, grant.grantId), eq(captureDeviceGrants.status, 'approved')))
      .returning({ deviceId: captureDeviceGrants.deviceId });
    if (!consumed?.deviceId) return null;
    const [row] = await tx
      .update(captureDevices)
      .set({ tokenHash: hashSecretKey(token), tokenIssuedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(captureDevices.deviceId, consumed.deviceId), isNull(captureDevices.revokedAt)))
      .returning();
    return row ?? null;
  });
  if (!device) return { kind: 'invalid_grant' };
  return { kind: 'token', token, prefix: projectPrefix(device.accountId, device.projectId), deviceId: device.deviceId, userId: device.userId };
}

/** The device behind a bearer device token, or null. Always read from the row: a revoke on any replica wins. */
export async function deviceForToken(header: string | undefined): Promise<Device | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const [device] = await db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.tokenHash, hashSecretKey(token)), isNull(captureDevices.revokedAt)))
    .limit(1);
  return device ?? null;
}

export async function deviceProject(projectId: string) {
  const [project] = await db
    .select({ metadata: projects.metadata, status: projects.status })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return project ?? null;
}

export async function markCredentialsIssued(deviceId: string): Promise<void> {
  await db.update(captureDevices).set({ lastCredentialsAt: sql`now()` }).where(eq(captureDevices.deviceId, deviceId));
}

const normalizeUserCode = (raw: string) =>
  raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

export async function grantByUserCode(userCode: string): Promise<Grant | null> {
  const [grant] = await db
    .select()
    .from(captureDeviceGrants)
    .where(eq(captureDeviceGrants.userCode, normalizeUserCode(userCode)))
    .limit(1);
  return grant ?? null;
}

/** Pair the device to `userId` in the project. Null when the grant was decided meanwhile. */
export async function approveDeviceGrant(
  grant: Grant,
  owner: { projectId: string; accountId: string; userId: string },
  /** The computer agent's id for this machine (sent by the Kortix desktop app). */
  machineId?: string,
): Promise<Grant | null> {
  const fields = { ...deviceFields(grant.deviceInfo), ...(machineId ? { machineId } : {}) };
  return db.transaction(async (tx) => {
    const [device] = await tx
      .insert(captureDevices)
      .values({ ...owner, machineKeySha256: grant.machineKeySha256, ...fields, deviceInfo: grant.deviceInfo })
      .onConflictDoUpdate({
        target: [captureDevices.projectId, captureDevices.machineKeySha256, captureDevices.userId],
        set: { ...fields, revokedAt: null, revokedBy: null, updatedAt: sql`now()` },
      })
      .returning({ deviceId: captureDevices.deviceId });
    const [updated] = await tx
      .update(captureDeviceGrants)
      .set({ status: 'approved', projectId: owner.projectId, userId: owner.userId, deviceId: device!.deviceId })
      .where(and(eq(captureDeviceGrants.grantId, grant.grantId), eq(captureDeviceGrants.status, 'pending')))
      .returning();
    return updated ?? null;
  });
}

export async function denyDeviceGrant(grant: Grant): Promise<Grant | null> {
  const [denied] = await db
    .update(captureDeviceGrants)
    .set({ status: 'denied' })
    .where(and(eq(captureDeviceGrants.grantId, grant.grantId), eq(captureDeviceGrants.status, 'pending')))
    .returning();
  return denied ?? null;
}
