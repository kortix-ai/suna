import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, 'page.tsx'), 'utf8');

/**
 * `/projects` is a redirect back to THIS route (`page.tsx`, Task 21). Before
 * this fix, the terminal "nothing to open" case
 * bounced there via `router.replace(withCurrentQuery('/projects'))`, which
 * looped forever the moment `/projects` stopped rendering a real list.
 *
 * Every assertion here is paired — absence of the loop AND presence of its
 * replacement — per this project's own Task 7 lesson: an absence-only test
 * survives a regression that guts the fix while dodging the literal string
 * that was removed.
 */
describe('/projects/start does not bounce to /projects', () => {
  test('the chooser branch renders inline instead of redirecting to /projects', () => {
    expect(source).not.toContain("withCurrentQuery('/projects')");
    expect(source).not.toContain("'/projects'");
    expect(source).toContain('setChooser({ canCreate: resolution.canCreate });');
    expect(source).toContain('<ProjectChooser');
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
describe('/projects/start never creates a project on its own', () => {
  // The auto-created "My First Project" hid pending invites from anyone who
  // signed up without the email link. The door now only OPENS projects; with
  // nothing to open it renders the chooser.
  test('the page holds no provisioning path', () => {
    expect(source).not.toContain('provisionProject');
    expect(source).not.toContain('ensureFirstProject');
    expect(source).toContain('<ProjectChooser');
  });
});

describe('/projects/start stuck states offer a sign-out escape hatch', () => {
  test('the error branch mounts StartSignOutButton; the chooser carries its own Log out row', () => {
    const mounts = source.split('<StartSignOutButton />').length - 1;
    expect(mounts).toBe(1);
    const chooser = readFileSync(resolve(import.meta.dir, 'project-chooser.tsx'), 'utf8');
    expect(chooser).toContain("tNew('actions.logOut')");
    expect(chooser).toContain('void performSignOut();');
  });

  // `resolve()` returns early on an empty list, so neither `chooser` nor
  // `failed` was ever set: the loading frame stayed up forever with no control.
  // On desktop, with no browser Back, that was a hard lock.
  test('an empty account list renders the chooser, not an endless loading frame', () => {
    expect(source).toContain('const noAccounts = accountsQuery.isSuccess && accountsQuery.data.length === 0;');
    expect(source).toContain('const shownChooser = chooser ?? (noAccounts ? { canCreate: false } : null);');
    expect(source).toContain('if (shownChooser) {');
    expect(source).toContain('canCreate={shownChooser.canCreate}');
    expect(source).not.toContain('if (chooser) {');
  });

  // The button used to sit at `top-4 right-4`. On Win/Linux the web-drawn
  // window controls cover that corner at z 100, so a click meant for Sign out
  // could land on minimise, maximise or close instead.
  test('the escape hatch clears the window controls on desktop', () => {
    const button = signOutButton();
    expect(button).toContain('kx-desktop-band-row');
    expect(button).not.toContain('absolute top-4 right-4');
    // The row spans the window; only the button takes clicks.
    expect(button).toContain('pointer-events-none');
    expect(button).toContain('pointer-events-auto');
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
