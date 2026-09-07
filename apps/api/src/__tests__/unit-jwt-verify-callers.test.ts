/**
 * Tripwire: every caller of `verifySupabaseJwt` must decide what a FAILURE
 * means through `isInconclusiveVerifyFailure`, never by comparing reasons by
 * hand.
 *
 * `jwt-verify-outcome.ts` says the two auth middlewares "route on this ONE
 * predicate so they cannot drift apart". A third caller appeared anyway —
 * `sandbox-proxy/preview-auth.ts`, the authenticator for the subdomain preview
 * origin and the preview WebSocket — with its own inline
 * `reason !== 'no-keys' && reason !== 'no-key-for-kid'`. It was missing
 * `unsupported-alg:*`.
 *
 * The consequence was invisible until a Supabase project published an ES256
 * JWKS while still SIGNING with the legacy HS256 secret. Local verification
 * then returned `unsupported-alg:HS256` — inconclusive, only the auth server
 * can check a symmetric signature. The middlewares fell back to the network and
 * served the token; preview-auth read the same reason as a verdict and refused.
 * Every browser preview origin answered 401 "Sign in to open this preview" to
 * the owner, while `/v1/p/<sandbox>/<port>/` served the same sandbox to the
 * same token.
 *
 * A comment could not stop that. This can: the next caller either uses the
 * shared predicate or this test names the file.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

/** Owns the reason strings; exempt by construction. */
const OWNERS = new Set(['shared/jwt-verify.ts', 'shared/jwt-verify-outcome.ts']);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
      acc.push(full);
    }
  }
  return acc;
}

const files = sourceFiles(SRC).map((full) => ({
  path: full.slice(SRC.length + 1),
  text: readFileSync(full, 'utf8'),
}));

describe('verifySupabaseJwt callers', () => {
  test('the scan actually found the source tree', () => {
    // A broken walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.path === 'shared/jwt-verify.ts')).toBe(true);
  });

  test('every caller routes failures through isInconclusiveVerifyFailure', () => {
    const callers = files.filter(
      (f) => !OWNERS.has(f.path) && f.text.includes('verifySupabaseJwt('),
    );
    // If this drops to zero the predicate below stops guarding anything.
    expect(callers.length).toBeGreaterThan(0);

    const missing = callers
      .filter((f) => !f.text.includes('isInconclusiveVerifyFailure'))
      .map((f) => f.path);
    expect(missing).toEqual([]);
  });

  test('nobody compares a verify reason by hand', () => {
    const offenders = files
      .filter((f) => !OWNERS.has(f.path))
      .filter((f) => /reason\s*[!=]==\s*'(?:no-keys|no-key-for-kid)'/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
