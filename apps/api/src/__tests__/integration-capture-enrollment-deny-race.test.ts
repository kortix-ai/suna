/**
 * An admin's deny of a Capture computer sticks against a concurrent enroll
 * call (real PostgreSQL).
 *
 * The enroll call reads the enrollment row, then mints a device token and
 * wrote `status = 'enrolled'` with `WHERE enrollment_id = ?` only. A deny that
 * committed in between was overwritten: the row read `enrolled` and the
 * computer held a fresh device token. The mint is now a compare-and-set that
 * refuses a `denied` row and rolls the token write back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, captureDevices, captureEnrollments, captureTenants } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { createEnrollmentToken, denyEnrollment, enroll, type EnrollInput } from '../capture/enrollment';
import { db } from '../shared/db';
import { interleave } from './helpers/interleave';

const ACCOUNT = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
let token = '';

function input(machine: string, deviceToken: string | null): EnrollInput {
  return {
    token,
    machineKey: machine,
    principalName: 'WORKSTATION\\tester',
    accountName: null,
    deviceInfo: { name: 'test-pc', os: 'windows' },
    deviceToken,
  };
}

async function enrollmentOf(machine: string) {
  const [row] = await db.select().from(captureEnrollments).where(eq(captureEnrollments.machineKeySha256, machine));
  return row!;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'capture-deny-race-test' });
  await db.insert(captureTenants).values({ accountId: ACCOUNT, enabled: true });
  const created = await createEnrollmentToken(
    ACCOUNT,
    { name: 'deny race', emailDomains: [], maxDevices: null, requireApproval: false, expiresAt: null, userId: null },
    ADMIN,
  );
  token = created.token;
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a Capture deny sticks against a racing enroll call', () => {
  test('an enroll that read the row before a deny committed is refused and mints nothing', async () => {
    const machine = 'd'.repeat(64);
    const first = await enroll(input(machine, null));
    expect(first.kind).toBe('enrolled');
    const deviceToken = first.kind === 'enrolled' ? first.token : '';
    const before = await enrollmentOf(machine);
    const [device] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, before.deviceId!));

    const outcome = await interleave(
      (tx) =>
        tx.query(`UPDATE kortix.capture_enrollments SET status = 'denied', decided_by = $2 WHERE enrollment_id = $1`, [
          before.enrollmentId,
          ADMIN,
        ]),
      () => enroll(input(machine, deviceToken)),
      'capture_enrollments',
    );

    expect(outcome.kind).toBe('denied');
    expect((await enrollmentOf(machine)).status).toBe('denied');
    // The token the computer held is still the stored one: no new token was minted.
    const [after] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, before.deviceId!));
    expect(after!.tokenHash).toBe(device!.tokenHash);
  });

  test('a deny revokes the device and later enroll calls answer denied', async () => {
    const machine = 'e'.repeat(64);
    const first = await enroll(input(machine, null));
    expect(first.kind).toBe('enrolled');
    const row = await enrollmentOf(machine);
    const denied = await denyEnrollment(row, ADMIN);
    expect(denied.status).toBe('denied');
    const [device] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, row.deviceId!));
    expect(device!.revokedAt).not.toBeNull();
    expect(device!.tokenHash).toBeNull();
    expect((await enroll(input(machine, null))).kind).toBe('denied');
  });
});
