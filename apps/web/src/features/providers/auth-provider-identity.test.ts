// `AuthProvider`'s cross-user reset, pinned at the wiring level.
//
// The decision itself lives in `lib/auth/identity-marker.ts` and is tested
// there against real inputs. What this file proves is that the provider
// actually ASKS it, at both entry points, and that the marker it compares
// against still exists when the comparison runs — which is the exact thing the
// `SIGNED_OUT` branch used to destroy.
//
// Source assertions, so comments are stripped before every match: this file's
// own prose names `safeRemoveItem` and `kortix-last-user-id`, and so does the
// module it guards.
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

describe('the SIGNED_OUT branch keeps the marker it will be compared against', () => {
  test('it no longer deletes kortix-last-user-id', () => {
    // The self-disarming guard: `SIGNED_OUT` removed the marker, so the later
    // `SIGNED_IN` comparison always read "absent" and — with the old
    // `prev && prev !== next` spelling — concluded "same user". The reset could
    // therefore never fire after an explicit logout.
    const branch = slice("case 'SIGNED_OUT':", "case 'TOKEN_REFRESHED':");
    expect(branch).not.toContain('safeRemoveItem');
    // Paired presence check: the branch still does its real job.
    expect(branch).toContain('await resetClientState();');
  });

  test('nothing in the provider removes the marker any more', () => {
    expect(code).not.toContain('safeRemoveItem');
  });
});

describe('the reset decision is the shared one, at BOTH entry points', () => {
  test('the provider asks shouldResetClientState and never re-spells the guard', () => {
    expect(code).toContain("from '@/lib/auth/identity-marker'");
    expect(code).toContain('shouldResetClientState({');
    // The exact shape that read an ABSENT marker as SAME USER (G3).
    expect(code).not.toContain('prevUserId && prevUserId !==');
  });

  test('the cold-load bootstrap adopts the user before publishing it', () => {
    const bootstrap = slice('const getInitialSession = async ()', 'getInitialSession();');
    const adopt = bootstrap.indexOf('await adoptUser(');
    const publish = bootstrap.indexOf('setSession(currentSession);');
    expect(adopt).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(adopt);
  });

  test('the auth listener adopts INITIAL_SESSION and SIGNED_IN before publishing', () => {
    // INITIAL_SESSION matters on its own: a cross-user COLD LOAD arrives as
    // that event, and it arrives before `getInitialSession()` finishes its
    // `getUser()` round trip. Without a case here the new user is published
    // while the previous one's caches are still mounted.
    const listener = slice('supabase.auth.onAuthStateChange(', 'setIsLoading((prev)');
    expect(listener).toContain("event === 'INITIAL_SESSION'");
    expect(listener).toContain("event === 'SIGNED_IN'");

    const adopt = listener.indexOf('await adoptUser(nextUserId);');
    const publish = listener.indexOf('setSession(newSession);');
    expect(adopt).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(adopt);
  });
});

describe('the marker is held per-document as well as in origin-wide storage', () => {
  test('a useRef carries the in-document half', () => {
    // One origin-wide localStorage key cannot describe several tabs: two tabs
    // signed into two accounts overwrite each other's marker while each keeps
    // its own React Query cache.
    expect(code).toContain('const lastUserIdRef = useRef<string | null>(null)');
    expect(code).toContain('inDocumentUserId: lastUserIdRef.current');
    expect(code).toContain('persistedUserId: safeGetItem(IDENTITY_MARKER_KEY)');
    expect(code).toContain('lastUserIdRef.current = nextUserId;');
  });

  test('a failed reset cannot leave the app parked on the loading frame', () => {
    // `adoptUser` runs before `setIsLoading(false)`. An escaping rejection
    // would strand every consumer on the loading state forever.
    const adopt = slice('const adoptUser = async (', 'const getInitialSession');
    expect(adopt).toContain('try {');
    expect(adopt).toContain('await resetClientState();');
    expect(adopt).toContain('} catch (error) {');
  });
});

describe("the provider's signOut is the shared one", () => {
  test('useAuth().signOut is performSignOut, not a provider-local cleanup', () => {
    expect(code).toContain("from '@/lib/auth/perform-sign-out'");
    expect(code).toContain('signOut: performSignOut');
    expect(code).not.toContain('await supabase.auth.signOut();\n      await resetClientState();');
  });
});
