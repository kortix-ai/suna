/**
 * Pure parsing/auth helpers for the git proxy — no DB/network imports so they
 * stay trivially unit-testable.
 */
import type { GitScope } from '../projects/git-backends';

/** Strip an optional trailing `.git` from the project path segment. */
export function normalizeProjectId(raw: string): string {
  return raw.replace(/\.git$/i, '');
}

/** Extract the bare token from a git `Authorization` header (Basic or Bearer). */
export function extractToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || !value) return null;
  const lower = scheme.toLowerCase();
  if (lower === 'bearer') return value.trim() || null;
  if (lower === 'basic') {
    let decoded: string;
    try {
      decoded = Buffer.from(value, 'base64').toString('utf8');
    } catch {
      return null;
    }
    // git basic auth is `<username>:<password>`; the token sits in the password
    // slot (username is the conventional but ignored `x-access-token`).
    const idx = decoded.indexOf(':');
    const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return password.trim() || null;
  }
  return null;
}

/**
 * Map a git smart-HTTP request to a read/write scope.
 *  - `git-receive-pack` (push) ⇒ write
 *  - `git-upload-pack` (fetch/clone) ⇒ read
 * `service` is the `?service=` query on /info/refs; for the POST endpoints the
 * pack name is in the path.
 */
export function scopeForService(service: string | undefined | null): GitScope {
  return service === 'git-receive-pack' ? 'write' : 'read';
}

/** Request headers worth forwarding to the upstream git server. */
export const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-encoding',
  'content-encoding',
  'git-protocol',
  'user-agent',
];

/** Response headers NOT to copy back (hop-by-hop / length recomputed by Bun). */
export const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'www-authenticate',
]);
