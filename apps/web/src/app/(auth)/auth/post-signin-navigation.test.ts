// The destination a sign-in navigates to must be the one the SERVER resolved.
//
// `signInWithPassword`, `verifyOtp` and `signUpWithPassword` each run the
// return URL through the identity gate (`shouldDemoteReturnUrl`) and hand back
// a `redirectTo`. `AuthContent` separately holds `returnUrl` — the RAW query
// param — and redirects to it the moment a session exists
// (`router.replace(returnUrl)`), which `setSession()` makes true milliseconds
// after the action returns. A soft `router.push(dest)` loses that race: the
// later `replace` supersedes it and lands the user on the path the middleware
// bounced here for a DIFFERENT account, neutralizing the gate on all three
// actions. A document navigation is already in flight by then, so it wins.
//
// Source assertions, in this directory's convention (`sso-entry.test.ts`):
// every anchor is asserted to exist before it is used, so a rename or a move
// fails this test instead of silently slicing it into something that cannot
// fail.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rawSource = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

/**
 * Comments stripped. This test's own prose quotes `router.push` and
 * `router.replace(returnUrl)`, and so does the code it guards — matching
 * against commented-out prose would make every assertion below pass on text
 * that never runs.
 */
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // `//` only when it is not a URL scheme, so `https://…` inside a string
  // survives intact and a navigation on that line is still visible.
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ESTABLISH_START = 'const establishSessionAndRedirect';
const ESTABLISH_END = 'const buildBaseFormData';

function establishBody(): string {
  const start = source.indexOf(ESTABLISH_START);
  const end = source.indexOf(ESTABLISH_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every navigation in a slice, as `[mechanism, argument]` pairs. */
function navigations(slice: string): string[][] {
  const pattern =
    /window\.location\.(assign|replace)\(([^)]*)\)|window\.location\.(href)\s*=\s*([^;]+);|router\.(push|replace|refresh)\(([^)]*)\)/g;
  return [...slice.matchAll(pattern)].map((match) => [
    match[1] ?? match[3] ?? match[5],
    (match[2] ?? match[4] ?? match[6] ?? '').trim(),
  ]);
}

describe('post-sign-in navigation', () => {
  test('is a HARD navigation, so the raw-returnUrl effect cannot supersede it', () => {
    const body = establishBody();

    expect(body).toContain('window.location.assign(dest)');
    expect(body).not.toContain('router.push');
    expect(body).not.toContain('router.refresh');
  });

  test('every navigation on the sign-in path carries a gated value', () => {
    // Enumerated, not spot-checked: adding `router.push(returnUrl)` — the exact
    // regression this pins — fails here rather than slipping in beside a
    // passing `toContain`.
    expect(navigations(establishBody())).toEqual([
      ['assign', 'mobileHandoffUrl'],
      ['assign', 'dest'],
    ]);
  });

  test('the destination is the server-resolved one, with the raw param only as a fallback', () => {
    expect(establishBody()).toContain('const dest = result?.redirectTo || returnUrl;');
  });

  test('the post-auth intent marker is still set before leaving the page', () => {
    // A hard navigation abandons the document. The marker is what proves "this
    // user just signed in" to the landing door; setting it after the navigation
    // starts would demote every signup to the projects list.
    const body = establishBody();
    const marker = body.indexOf('markPostAuthIntent()');
    const leave = body.indexOf('window.location.assign(dest)');

    expect(marker).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(marker);
  });

  test('the sign-in form holds no soft router at all', () => {
    const start = source.indexOf('function AuthCardForm(');
    const end = source.indexOf('function AuthContent(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    expect(source.slice(start, end)).not.toContain('useRouter()');
  });

  test('exactly one navigation in the file still takes the raw returnUrl', () => {
    // `AuthContent`'s already-signed-in redirect. It is a known residual: the
    // bounce cookie is httpOnly, so this client component cannot read it to
    // apply the same gate. Pinned at ONE so a second ungated navigation cannot
    // appear unnoticed.
    const raw = source.match(/router\.(?:push|replace)\(returnUrl\)/g) ?? [];

    expect(raw.length).toBe(1);
  });
});
