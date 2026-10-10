// The Web Push key pair on PostgreSQL (KRTX-1742): generated once per
// environment even when two replicas read it first at the same time, the
// private key sealed at rest, and the pair one that signs and verifies.
import { describe, expect, test } from 'bun:test';
import { createPublicKey, sign, verify } from 'node:crypto';
import { platformSettings } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { forgetVapidKeysForTest, getVapidKeyPair, getVapidPublicKey, loadOrCreateVapidKeys, VAPID_SETTING_KEY } from './vapid-keys';

async function storedRows() {
  return db.select().from(platformSettings).where(eq(platformSettings.key, VAPID_SETTING_KEY));
}

describe('the VAPID key pair', () => {
  test('two concurrent first reads store one pair and both return it', async () => {
    expect(await storedRows()).toHaveLength(0);
    const [first, second] = await Promise.all([loadOrCreateVapidKeys(), loadOrCreateVapidKeys()]);

    expect(first.publicKey).toBe(second.publicKey);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.value as { public_key: string }).public_key).toBe(first.publicKey);
  });

  test('the stored private key is sealed, and the pair signs what the public key verifies', async () => {
    const pair = await loadOrCreateVapidKeys();
    const [row] = await storedRows();
    const value = row!.value as { public_key: string; private_key_enc: string };
    const d = (pair.privateKey.export({ format: 'jwk' }) as { d: string }).d;
    expect(JSON.stringify(value)).not.toContain(d);
    expect(Object.keys(value).sort()).toEqual(['private_key_enc', 'public_key']);

    const point = Buffer.from(pair.publicKey, 'base64url');
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const signature = sign('sha256', Buffer.from('payload'), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
    expect(verify('sha256', Buffer.from('payload'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
  });

  test('the process reads the row once and serves the same key after a restart', async () => {
    forgetVapidKeysForTest();
    const stored = (await loadOrCreateVapidKeys()).publicKey;
    const [a, b] = await Promise.all([getVapidKeyPair(), getVapidKeyPair()]);
    expect(a).toBe(b);
    expect(await getVapidPublicKey()).toBe(stored);
    forgetVapidKeysForTest();
    expect(await getVapidPublicKey()).toBe(stored);
  });

  test('a tampered sealed key is refused, not used', async () => {
    const [row] = await storedRows();
    const value = row!.value as { public_key: string; private_key_enc: string };
    const sealed = Buffer.from(value.private_key_enc, 'base64url');
    sealed[sealed.length - 1] ^= 1;
    await db.update(platformSettings)
      .set({ value: { ...value, private_key_enc: sealed.toString('base64url') } })
      .where(eq(platformSettings.key, VAPID_SETTING_KEY));
    forgetVapidKeysForTest();
    await expect(getVapidKeyPair()).rejects.toThrow();
    await db.update(platformSettings).set({ value }).where(eq(platformSettings.key, VAPID_SETTING_KEY));
    expect(await getVapidPublicKey()).toBe(value.public_key);
  });
});
