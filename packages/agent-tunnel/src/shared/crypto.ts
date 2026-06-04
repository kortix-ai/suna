import { createHash, createHmac, timingSafeEqual, randomBytes } from 'crypto';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphanumeric(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[bytes[i]! % CHARS.length];
  }
  return result;
}

export function deriveSigningKey(token: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(token)
    .digest('hex');
}

export function signMessage(signingKey: string, payload: string, nonce: number): string {
  return createHmac('sha256', signingKey)
    .update(`${nonce}:${payload}`)
    .digest('hex');
}

export function verifyMessageSignature(
  signingKey: string,
  payload: string,
  nonce: number,
  signature: string,
): boolean {
  try {
    const expected = signMessage(signingKey, payload, nonce);
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function generateToken(prefix = 'tnl_'): string {
  return `${prefix}${randomAlphanumeric(32)}`;
}

export function hashToken(token: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(token)
    .digest('hex');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
