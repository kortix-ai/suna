import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, 'page.tsx'), 'utf8');

/**
 * `/projects` is a redirect back to THIS route (`page.tsx`, Task 21). Before
 * this fix, the terminal "nothing to open, nothing to auto-create" case
 * bounced there via `router.replace(withCurrentQuery('/projects'))`, which
 * looped forever the moment `/projects` stopped rendering a real list.
 *
 * Every assertion here is paired — absence of the loop AND presence of its
 * replacement — per this project's own Task 7 lesson: an absence-only test
 * survives a regression that guts the fix while dodging the literal string
 * that was removed.
 */
describe('/projects/start does not bounce to /projects', () => {
  test('the terminal branch renders inline instead of redirecting to /projects', () => {
    expect(source).not.toContain("withCurrentQuery('/projects')");
    expect(source).not.toContain("'/projects'");
    expect(source).toContain('setTerminal(classifyLandingTerminal(');
    expect(source).toContain('<ProjectStartEmpty');
  });

  test("the failure screen's secondary action does not point back at /projects either", () => {
    expect(source).not.toContain('href="/projects"');
    expect(source).toContain('href="/new"');
  });

  test('the only /projects destination left is a real project id, never the bare list', () => {
    expect(source).toContain('withCurrentQuery(`/projects/${project.project_id}`)');
  });
});

/**
 * `StartSignOutButton`'s executable text, comments stripped.
 *
 * The doc comment above the component legitimately names the old mechanism, so
 * matching against raw source here would let an assertion pass on prose that
 * never runs. Both anchors are checked, so a rename fails this instead of
 * quietly producing an empty slice.
 */
function signOutButton(): string {
  const start = source.indexOf('function StartSignOutButton()');
  const end = source.indexOf('function ProjectStartError(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The terminal and error states render with zero app chrome, so without an
 * explicit control a user parked there could not sign out and try another
 * account — the page was a dead end. Both stuck branches must mount the
 * escape hatch; the transient skeleton must not (it is a loading frame, not
 * a destination).
 */
/**
 * JAY: symptom 5. `isAutoProjectSuppressed()` used to be called with no
 * argument — a process-wide flag with no owner. It now takes an account id
 * and this route must never call it with a bare, unbound check.
 *
 * Review round 1 found the FIRST fix here (`accounts.some((account) =>
 * isAutoProjectSuppressed(account.account_id))`) too broad: it suppressed
 * auto-create on ANY account the caller owns if ANY of them had a live flag,
 * while `resolveLandingDestination` only ever gates creation for ONE primary
 * candidate account. The scoping now lives THERE
 * (`resolve-landing-destination.ts` — see its own tests for the behavioral
 * proof), and this route just passes `isAutoProjectSuppressed` straight
 * through as a per-account predicate.
 */
describe('/projects/start binds the suppression check to real accounts', () => {
  test('never calls isAutoProjectSuppressed() with zero arguments', () => {
    expect(source).not.toContain('isAutoProjectSuppressed()');
  });

  test('passes isAutoProjectSuppressed straight through, not pre-reduced to a single boolean here', () => {
    expect(source).toContain('isAccountSuppressed: isAutoProjectSuppressed,');
    // The bug this guards against: computing `.some(...)` over every account
    // the caller owns HERE would let a flag on one account suppress creation
    // on an unrelated one owned by the same user. Scoping to the actual
    // primary candidate is resolveLandingDestination's job now, not this
    // route's — so this route must never itself reduce the check to a
    // single account-agnostic boolean.
    expect(source).not.toContain('accounts.some((account) => isAutoProjectSuppressed');
  });
});

describe('/projects/start stuck states offer a sign-out escape hatch', () => {
  test('terminal AND error branches mount StartSignOutButton', () => {
    const mounts = source.split('<StartSignOutButton />').length - 1;
    expect(mounts).toBe(2);
  });

  test('the escape hatch signs out through the one shared sign-out', () => {
    // `performSignOut` owns the whole sequence — read the `{ error }`, retry
    // locally, clear the bounce cookie, reset every client cache, then leave.
    // The button contributes only the press.
    expect(signOutButton()).toContain('void performSignOut();');
  });

  test('the escape hatch leaves on a DOCUMENT load, never a soft navigation', () => {
    // It used to be `await signOut()` followed by a soft replace to /auth. A
    // soft navigation keeps the App Router route cache, the segment cache and
    // bfcache across an identity change, and `resetClientState()` reaches none
    // of the three. `performSignOut` ends on `window.location.assign` — see
    // `lib/auth/sign-out-navigation.test.ts` for the enumerated proof.
    const button = signOutButton();
    expect(button).not.toContain('router.replace');
    expect(button).not.toContain('router.push');
    // The warm-up went with it: a document load never reads the segment cache.
    expect(button).not.toContain('router.prefetch');
  });
});
