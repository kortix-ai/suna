import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A signed-in user must never see an empty project list.
 *
 * `/` resolves them into a project and provisions one when there is none;
 * `/projects` bounces to `/` when it has nothing to show. Those two rules point
 * at each other, so the ONLY thing keeping them from looping forever is the
 * `?empty=1` marker: `/` sets it when it has already tried and failed, and the
 * list stands down when it sees it.
 *
 * This guards that contract at the source level — a redirect loop is not
 * something a unit test can observe, but a missing marker is.
 */

const HERE = import.meta.dir;
const HOME = readFileSync(join(HERE, 'page.tsx'), 'utf8');
const LIST = readFileSync(join(HERE, 'projects', 'page.tsx'), 'utf8');

describe('/ never leaves a signed-in user with nothing', () => {
  test('provisions a project when there is none to open', () => {
    expect(HOME).toContain('provisionProjectWithToken');
  });

  test('every redirect back to the list carries the marker', () => {
    // A bare `redirect('/projects')` here is the loop.
    const bare = HOME.match(/redirect\(['"]\/projects['"]\)/g) ?? [];
    expect(bare).toEqual([]);

    const assignments = HOME.match(/path = ['"]\/projects[^'"]*['"]/g) ?? [];
    const unmarked = assignments.filter((line) => !line.includes('empty=1'));
    // The initial `let path = '/projects'` is the resolver's own sentinel and
    // is always either replaced or overwritten before the redirect.
    expect(unmarked.length).toBeLessThanOrEqual(1);
  });

  test('still never redirects to /auth', () => {
    expect(HOME).not.toContain("redirect('/auth')");
  });
});

describe('/projects stands down instead of showing an empty list', () => {
  test('bounces to / when it has loaded and has nothing', () => {
    expect(LIST).toContain("router.replace('/')");
  });

  test('honours the marker so the two routes cannot loop', () => {
    expect(LIST).toContain("searchParams.get('empty') === '1'");
  });

  test('leaves explicit intent alone', () => {
    // ?new=1 and ?clone= mean the user asked to be on this page.
    const guard = LIST.slice(LIST.indexOf("searchParams.get('empty')"));
    expect(guard).toContain("searchParams.get('new') === '1'");
    expect(guard).toContain("searchParams.get('clone')");
  });

  test('waits for the query before deciding', () => {
    const guard = LIST.slice(LIST.indexOf("searchParams.get('empty')"));
    expect(guard).toContain('projectsQuery.isLoading');
    expect(guard).toContain('projectsQuery.isError');
  });
});

describe('signup provisioning is not gated on billing', () => {
  const CALLBACK = readFileSync(join(HERE, '..', '(auth)', 'auth', 'callback', 'route.ts'), 'utf8');

  test('the first project is provisioned outside the billing branch', () => {
    // It used to live inside `if (billingEnabled …)`, so a stack with billing
    // off gave every new signup an empty account.
    const provisionAt = CALLBACK.indexOf('resolveFirstProjectPathForNewUser');
    const billingAt = CALLBACK.indexOf('if (billingEnabled');
    expect(provisionAt).toBeGreaterThan(-1);
    expect(billingAt).toBeGreaterThan(-1);
    expect(CALLBACK).toContain('if (isNewUser && canBootstrap && !blockedOnBilling)');
  });

  test('an account without app access is still sent to billing first', () => {
    expect(CALLBACK).toContain('blockedOnBilling = true');
  });

  test('invited users are never diverted into a fresh project', () => {
    expect(CALLBACK).toContain('isInviteReturnUrl(next)');
  });
});
