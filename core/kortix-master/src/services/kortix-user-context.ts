/**
 * Verifies the `X-Kortix-User-Context` header the preview proxy attaches
 * to every authenticated request. Same serialization format as the signer
 * in apps/api — kept as a separate module here so kortix-master has zero
 * runtime deps on the API package.
 *
 * Format: `<base64url(json payload)>.<base64url(HMAC-SHA256)>`
 * Secret: the sandbox's `KORTIX_TOKEN` (shared with the proxy that signed it).
 */

import { createHmac, timingSafeEqual } from 'crypto'

export const KORTIX_USER_CONTEXT_HEADER = 'X-Kortix-User-Context'

export interface KortixUserContext {
  userId: string
  sandboxId: string
  sandboxRole: 'owner' | 'admin' | 'member' | 'platform_admin'
  scopes: string[]
  iat: number
  exp: number
}

function base64urlDecode(s: string): Buffer {
  const pad = 4 - (s.length % 4)
  const padded = pad < 4 ? s + '='.repeat(pad) : s
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function sign(payloadB64: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(payloadB64).digest()
  return base64urlEncode(mac)
}

export type VerifyResult =
  | { ok: true; context: KortixUserContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' }

export function verifyKortixUserContext(
  token: string | undefined | null,
  secret: string,
): VerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [payloadB64, sig] = parts
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' }

  const expectedSig = sign(payloadB64, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let payload: KortixUserContext
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as KortixUserContext
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, context: payload }
}
