// The Web Push wire protocol (KRTX-1742) on node:crypto, no dependency:
//   - RFC 8291 message encryption: aes128gcm (RFC 8188), one record, rs 4096;
//   - RFC 8292 VAPID: `Authorization: vapid t=<ES256 JWT>, k=<public key>`.
// The endpoint is a URL a browser handed us, so the POST goes through
// `safeEgressFetch` (DNS-pinned, private ranges refused) and only to a known
// push service host. A timeout is not retried: the push may have arrived.
import { createCipheriv, createECDH, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isAllowedWebPushHost } from '@kortix/shared/notification-kinds';
import { safeEgressFetch } from '../shared/ssrf-guard';

export const WEB_PUSH_TTL_SECONDS = 3600;
export const WEB_PUSH_TIMEOUT_MS = 10_000;
export const VAPID_SUBJECT = 'mailto:support@kortix.com';
const VAPID_TOKEN_TTL_SECONDS = 12 * 3600;
const RECORD_SIZE = 4096;
// One record: header (86) + plaintext + delimiter (1) + tag (16) <= 4096.
export const WEB_PUSH_MAX_PLAINTEXT_BYTES = RECORD_SIZE - 86 - 1 - 16;

export interface WebPushTarget {
  endpoint: string;
  /** base64url 65-byte uncompressed P-256 point of the browser. */
  p256dh: string;
  /** base64url 16-byte auth secret of the browser. */
  auth: string;
}

export interface VapidKeyPair {
  /** base64url 65-byte uncompressed P-256 point. */
  publicKey: string;
  privateKey: KeyObject;
}

export type PushFetch = (url: string, init: RequestInit & { maxRedirects?: number }) => Promise<Response>;

export type WebPushOutcome = 'sent' | 'gone' | 'refused' | 'failed';

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/**
 * The aes128gcm body for one push. `sender` and `salt` are fixed only by the
 * RFC 8291 known-answer test; a real push uses a fresh key pair and salt.
 */
export function encryptWebPushPayload(
  plaintext: Buffer | string,
  target: Pick<WebPushTarget, 'p256dh' | 'auth'>,
  fixed: { senderPrivateKey?: Buffer; salt?: Buffer } = {},
): Buffer {
  const data = Buffer.from(plaintext);
  if (data.length > WEB_PUSH_MAX_PLAINTEXT_BYTES) throw new Error(`web push payload is ${data.length} bytes`);
  const uaPublic = Buffer.from(target.p256dh, 'base64url');
  const authSecret = Buffer.from(target.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (fixed.senderPrivateKey) ecdh.setPrivateKey(fixed.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdh.computeSecret(uaPublic), authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the delimiter of the last (and only) record, no padding.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** The VAPID `Authorization` header for `endpoint` (RFC 8292). */
export function vapidAuthorization(endpoint: string, vapid: VapidKeyPair, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + VAPID_TOKEN_TTL_SECONDS,
    sub: VAPID_SUBJECT,
  }));
  // JOSE wants the raw r||s signature, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/** True for an https URL on a known push service host with no userinfo and no port. */
export function isDeliverableEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && isAllowedWebPushHost(url.hostname);
}

/**
 * POST one encrypted push. 'gone': the push service dropped the subscription
 * (404/410), delete it. 'refused': the endpoint is not a push service URL.
 * Any other non-2xx, a redirect, a network error or a timeout is 'failed'.
 */
export async function sendWebPushMessage(
  target: WebPushTarget,
  payload: string,
  options: { vapid: VapidKeyPair; urgency: 'high' | 'normal'; fetch?: PushFetch; timeoutMs?: number },
): Promise<{ outcome: WebPushOutcome; status?: number }> {
  if (!isDeliverableEndpoint(target.endpoint)) return { outcome: 'refused' };
  const send = options.fetch ?? safeEgressFetch;
  try {
    const res = await send(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(target.endpoint, options.vapid),
        TTL: String(WEB_PUSH_TTL_SECONDS),
        Urgency: options.urgency,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(encryptWebPushPayload(payload, target)),
      signal: AbortSignal.timeout(options.timeoutMs ?? WEB_PUSH_TIMEOUT_MS),
      // A push service never redirects; a 3xx is a failure, never a second POST.
      maxRedirects: 0,
    });
    if (res.status >= 200 && res.status < 300) return { outcome: 'sent', status: res.status };
    if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status };
    return { outcome: 'failed', status: res.status };
  } catch {
    return { outcome: 'failed' };
  }
}
