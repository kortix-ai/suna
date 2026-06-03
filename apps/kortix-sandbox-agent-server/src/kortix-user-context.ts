/**
 * Verify-only mirror of apps/api/src/shared/kortix-user-context.ts.
 *
 * The API signs `X-Kortix-User-Context` with the sandbox's KORTIX_TOKEN; the
 * daemon validates it before forwarding to opencode. Pure module — no I/O.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export const KORTIX_USER_CONTEXT_HEADER = 'X-Kortix-User-Context'

interface KortixUserContext {
  userId: string
  sandboxId: string
  sandboxRole: 'owner' | 'admin' | 'member' | 'platform_admin'
  scopes: string[]
  iat: number
  exp: number
}

export type VerifyResult =
  | { ok: true; context: KortixUserContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_json' }

function base64urlDecode(s: string): Buffer {
  const pad = 4 - (s.length % 4)
  const padded = pad < 4 ? s + '='.repeat(pad) : s
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sign(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64).digest()
}

function base64urlEncodeBuf(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function verifyKortixUserContext(
  token: string | undefined | null,
  secret: string,
): VerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [payloadB64, sig] = parts
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' }

  const expectedSig = base64urlEncodeBuf(sign(payloadB64, secret))
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
