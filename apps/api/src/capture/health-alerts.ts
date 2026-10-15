/**
 * Fleet health alerts. When a Kortix Capture computer is not recording for
 * `KORTIX_CAPTURE_ALERT_AFTER_MINUTES` of awake time (health.ts), the people
 * with `capture.manage` in its account get one inbox row (plus the push and
 * email their preferences allow), and one more when it records again.
 *
 * No state table. The inbox row IS the state, keyed per recipient:
 *   capture-down:<device_id>:<since_ms>   the alert for one not-recording spell
 *   capture-up:<device_id>:<since_ms>     the recovery of that spell
 * `since` is the moment the spell began, so it stays the same on every poll.
 * The unique (user_id, dedupe_key) of the inbox makes a repeat tick, or a
 * second replica, write nothing. A spell is open while a down row has no up row.
 */
import { accountMembers, captureDevices, captureWorkspaces, notifications } from '@kortix/db';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { actorForUser } from '../iam/actor';
import { authorize } from '../iam/authorize';
import { logger } from '../lib/logger';
import { deliver } from '../notifications/notifier';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { classifyDevice, type DeviceHealth } from './health';
import { latestCaptureVersion } from './update-manifest';

const DOWN = 'capture-down:';
const UP = 'capture-up:';
/** A spell older than this is closed without a recovery notice (the computer may be gone). */
const SPELL_WINDOW = '14 days';
const MEMBER_SCAN_LIMIT = 2000;

export const downKey = (deviceId: string, sinceMs: number) => `${DOWN}${deviceId}:${sinceMs}`;
export const upKey = (deviceId: string, sinceMs: number) => `${UP}${deviceId}:${sinceMs}`;

/** `{deviceId, sinceMs}` of a down key, or null. */
export function parseDownKey(key: string | null): { deviceId: string; sinceMs: number } | null {
  const m = /^capture-down:([0-9a-f-]{36}):(\d+)$/.exec(key ?? '');
  return m ? { deviceId: m[1]!, sinceMs: Number(m[2]) } : null;
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** The alert text for a not-recording spell. English: the inbox stores one text per row. */
export function downText(name: string | null, health: DeviceHealth, now: number): { title: string; body: string } {
  const since = health.since ? Date.parse(health.since) : now;
  const reason = health.reasons[0];
  const body =
    reason === 'offline'
      ? `No report for ${duration(now - since)}.`
      : reason === 'stalled'
        ? `No new frame for ${duration(now - since)} while the computer was awake.`
        : `Not recording for ${duration(now - since)} while the computer was awake.`;
  return { title: name?.trim() || 'A computer', body };
}

interface AlertDevice {
  deviceId: string;
  accountId: string;
  name: string | null;
  health: DeviceHealth;
}

async function watchedDevices(now: number, latestVersion: string | null, accountId?: string): Promise<AlertDevice[]> {
  const rows = await db
    .select({
      deviceId: captureDevices.deviceId,
      accountId: captureDevices.accountId,
      name: captureDevices.name,
      appVersion: captureDevices.appVersion,
      status: captureDevices.status,
      reportedAt: captureDevices.statusReportedAt,
    })
    .from(captureDevices)
    .innerJoin(captureWorkspaces, eq(captureWorkspaces.accountId, captureDevices.accountId))
    .where(
      and(
        isNull(captureDevices.revokedAt),
        eq(captureWorkspaces.enabled, true),
        isNotNull(captureDevices.status),
        ...(accountId ? [eq(captureDevices.accountId, accountId)] : []),
      ),
    );
  const notRecordingAfterMs = config.KORTIX_CAPTURE_ALERT_AFTER_MINUTES * 60_000;
  return rows.map((row) => ({
    deviceId: row.deviceId,
    accountId: row.accountId,
    name: row.name,
    health: classifyDevice({ status: row.status, reportedAt: row.reportedAt, appVersion: row.appVersion }, { now, latestVersion, notRecordingAfterMs }),
  }));
}

/** Members of the account that hold `capture.manage`. A background job is not a sign-in: the MFA step-up does not apply (same rule as the email digest). */
export async function captureManagers(accountId: string): Promise<string[]> {
  const members = await db.select({ userId: accountMembers.userId }).from(accountMembers).where(eq(accountMembers.accountId, accountId)).limit(MEMBER_SCAN_LIMIT);
  const verdicts = await Promise.all(
    members.map(async ({ userId }) => ((await authorize(actorForUser(userId, accountId, { mfaAal: 'aal2' }), ACCOUNT_ACTIONS.CAPTURE_MANAGE)).allowed ? userId : null)),
  );
  return verdicts.filter((id): id is string => id !== null);
}

/** Open spells: a down row with no up row, newest 14 days, in these accounts. */
async function openSpells(accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({ userId: notifications.userId, accountId: notifications.accountId, dedupeKey: notifications.dedupeKey })
    .from(notifications)
    .where(
      and(
        eq(notifications.kind, 'capture_device_down'),
        inArray(notifications.accountId, accountIds),
        gt(notifications.createdAt, sql`now() - ${SPELL_WINDOW}::interval`),
        sql`NOT EXISTS (
          SELECT 1 FROM kortix.notifications u
          WHERE u.user_id = ${qualifiedColumn(notifications.userId)} AND u.dedupe_key = ${UP} || substr(${qualifiedColumn(notifications.dedupeKey)}, ${DOWN.length + 1})
        )`,
      ),
    );
  return rows.flatMap((row) => {
    const key = parseDownKey(row.dedupeKey);
    return key ? [{ ...key, userId: row.userId, accountId: row.accountId }] : [];
  });
}

export interface HealthTickResult {
  alerted: number;
  recovered: number;
}

/**
 * One pass over every watched computer, or over one account's (the device sync
 * route, which reads a device's status now). Idempotent across ticks and replicas.
 */
export async function runCaptureHealthTick(now = Date.now(), accountId?: string): Promise<HealthTickResult> {
  const result: HealthTickResult = { alerted: 0, recovered: 0 };
  const alertAfterMs = config.KORTIX_CAPTURE_ALERT_AFTER_MINUTES * 60_000;
  const devices = await watchedDevices(now, await latestCaptureVersion(now), accountId);
  const byId = new Map(devices.map((d) => [d.deviceId, d]));
  const managers = new Map<string, Promise<string[]>>();
  const managersOf = (accountId: string) => {
    if (!managers.has(accountId)) managers.set(accountId, captureManagers(accountId));
    return managers.get(accountId)!;
  };

  const sinceOf = (d: AlertDevice) => (d.health.state === 'not_recording' && d.health.since ? Date.parse(d.health.since) : null);

  for (const device of devices) {
    const since = sinceOf(device);
    if (since === null || now - since < alertAfterMs) continue;
    const recipients = await managersOf(device.accountId);
    const { title, body } = downText(device.name, device.health, now);
    const delivered = await deliver({
      kind: 'capture_device_down',
      accountId: device.accountId,
      title,
      body,
      recipients,
      dedupeKey: downKey(device.deviceId, since),
    });
    result.alerted += delivered.filter((r) => r.notificationId).length;
  }

  const spells = await openSpells([...new Set(devices.map((d) => d.accountId))]);
  for (const spell of spells) {
    const device = byId.get(spell.deviceId);
    // Gone (revoked, Capture off): nothing to report. The 14-day window closes the spell.
    if (!device) continue;
    if (sinceOf(device) === spell.sinceMs) continue;
    const delivered = await deliver({
      kind: 'capture_device_recovered',
      accountId: spell.accountId,
      title: device.name?.trim() || 'A computer',
      body: 'Recording again.',
      recipients: [spell.userId],
      dedupeKey: upKey(spell.deviceId, spell.sinceMs),
    });
    result.recovered += delivered.filter((r) => r.notificationId).length;
  }
  if (result.alerted || result.recovered) logger.info('[capture] health alerts', { ...result });
  return result;
}
