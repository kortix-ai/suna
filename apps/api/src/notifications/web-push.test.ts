// The Web Push wire format against its standards: the RFC 8291 section 5
// example (exact body for the published keys, salt and plaintext) and the
// RFC 8292 VAPID header (ES256 JWT that verifies with the public key).
import { describe, expect, test } from 'bun:test';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { fakePushBrowser as fakeBrowser } from '../__tests__/helpers/web-push-browser';
import {
  encryptWebPushPayload,
  sendWebPushMessage,
  vapidAuthorization,
  VAPID_SUBJECT,
  type PushFetch,
  type VapidKeyPair,
} from './web-push';

// RFC 8291 section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function vapidPair(): VapidKeyPair & { verifyKey: ReturnType<typeof createPublicKey> } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    publicKey: raw.toString('base64url'),
    privateKey: createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...jwk }, format: 'jwk' }),
    verifyKey: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }),
  };
}

describe('RFC 8291 message encryption', () => {
  test('the section 5 example produces the published body byte for byte', () => {
    const body = encryptWebPushPayload(RFC.plaintext, { p256dh: RFC.receiverPublic, auth: RFC.auth }, {
      senderPrivateKey: Buffer.from(RFC.senderPrivate, 'base64url'),
      salt: Buffer.from(RFC.salt, 'base64url'),
    });
    expect(body.toString('base64url')).toBe(RFC.body);
  });

  test('a real push uses a fresh sender key and salt, and the browser decrypts it', () => {
    const browser = fakeBrowser();
    const first = encryptWebPushPayload('{"title":"Done"}', browser);
    const second = encryptWebPushPayload('{"title":"Done"}', browser);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.readUInt32BE(16)).toBe(4096);
    expect(first.readUInt8(20)).toBe(65);
    expect(browser.decrypt(first)).toBe('{"title":"Done"}');
  });

  test('a payload larger than one 4096-byte record is refused', () => {
    expect(() => encryptWebPushPayload('x'.repeat(4000), fakeBrowser())).toThrow('web push payload');
  });
});

describe('RFC 8292 VAPID', () => {
  test('the header carries an ES256 JWT for the endpoint origin and the public key', () => {
    const vapid = vapidPair();
    const now = 1_760_000_000;
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', vapid, now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match!;
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: VAPID_SUBJECT });
    expect(claims.exp - now).toBeLessThanOrEqual(24 * 3600);
    expect(k).toBe(vapid.publicKey);
    expect(Buffer.from(k!, 'base64url')).toHaveLength(65);
    const signature = Buffer.from(s!, 'base64url');
    expect(signature).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: vapid.verifyKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
  });
});

describe('sending one push', () => {
  const target = (endpoint: string) => ({ endpoint, ...fakeBrowser() });
  const answer = (status: number): PushFetch => async () => new Response(null, { status });

  test('one POST with the aes128gcm body and the push headers', async () => {
    const vapid = vapidPair();
    const browser = fakeBrowser();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await sendWebPushMessage(
      { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', ...browser },
      '{"title":"Done"}',
      { vapid, urgency: 'high', fetch: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 201 }); } },
    );
    expect(result).toEqual({ outcome: 'sent', status: 201 });
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.init.method).toBe('POST');
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('ttl')).toBe('3600');
    expect(headers.get('urgency')).toBe('high');
    expect(headers.get('topic')).toBeNull();
    expect(headers.get('authorization')).toStartWith('vapid t=');
    expect(browser.decrypt(calls[0]!.init.body as Uint8Array)).toBe('{"title":"Done"}');
  });

  test('404 and 410 mean the subscription is gone; a redirect or a 5xx is a failure', async () => {
    const vapid = vapidPair();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/x';
    expect((await sendWebPushMessage(target(endpoint), '{}', { vapid, urgency: 'normal', fetch: answer(410) })).outcome).toBe('gone');
    expect((await sendWebPushMessage(target(endpoint), '{}', { vapid, urgency: 'normal', fetch: answer(404) })).outcome).toBe('gone');
    expect((await sendWebPushMessage(target(endpoint), '{}', { vapid, urgency: 'normal', fetch: answer(302) })).outcome).toBe('failed');
    expect((await sendWebPushMessage(target(endpoint), '{}', { vapid, urgency: 'normal', fetch: answer(503) })).outcome).toBe('failed');
  });

  test('a timeout fails once and is not retried', async () => {
    let calls = 0;
    const hang: PushFetch = (_url, init) => {
      calls += 1;
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const result = await sendWebPushMessage(target('https://web.push.apple.com/abc'), '{}', {
      vapid: vapidPair(), urgency: 'normal', fetch: hang, timeoutMs: 20,
    });
    expect(result.outcome).toBe('failed');
    expect(calls).toBe(1);
  });

  test('an endpoint that is not a push service is refused without a request', async () => {
    let calls = 0;
    const counting: PushFetch = async () => { calls += 1; return new Response(null, { status: 201 }); };
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://internal-alb.vpc.local/admin',
      'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com:8443/x',
      'http://fcm.googleapis.com/x',
      'https://user:pw@fcm.googleapis.com/x',
    ]) {
      expect((await sendWebPushMessage(target(endpoint), '{}', { vapid: vapidPair(), urgency: 'normal', fetch: counting })).outcome).toBe('refused');
    }
    expect(calls).toBe(0);
  });
});
