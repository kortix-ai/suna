// `AuthProvider`'s stale-session sign-out, pinned at the wiring level.
//
// The decision lives in `lib/auth/session-rejection.ts` and is tested there
// against supabase-js's real error classes. What this file proves is that the
// provider ASKS it before signing out, instead of signing out on any
// `getUser()` error — which is what it did until 2026-09-17, when the GitHub
// identity-proof popup's self-close aborted its own `getUser()` and the
// provider answered by clearing the cookie every tab shares.
//
// Source assertions with comments stripped, same convention as
// `auth-provider-identity.test.ts`: the module's own comments name the old
// behaviour in prose.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const raw = readFileSync(resolve(import.meta.dir, 'auth-provider.tsx'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function slice(startAnchor: string, endAnchor: string): string {
  const start = code.indexOf(startAnchor);
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf(endAnchor, start + startAnchor.length);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe('the initial-session validation signs out only on a definitive rejection', () => {
  const validation = slice('supabase.auth.getUser(),', 'await adoptUser(');

  test('the provider imports the shared predicate', () => {
    expect(code).toContain("from '@/lib/auth/session-rejection'");
  });

  test('signOut is guarded by isDefinitiveSessionRejection, not by the bare error', () => {
    expect(validation).toContain('AUTH_BOOTSTRAP_TIMEOUT_MS');
    expect(validation).toContain('userError && isDefinitiveSessionRejection(userError)');
    expect(validation).toContain('await supabase.auth.signOut();');
    // The exact shape that signed the whole browser out on an aborted fetch.
    expect(validation).not.toMatch(/if \(userError\) \{\s*console\.warn\([^)]*signing out/);
  });

  test('a non-definitive error keeps the session and only logs', () => {
    const kept = validation.slice(validation.indexOf('if (userError) {'));
    expect(kept).toContain('keeping it');
    expect(kept).not.toContain('signOut');
    expect(kept).not.toContain('setUser(null)');
  });
});
