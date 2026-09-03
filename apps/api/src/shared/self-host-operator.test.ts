import { describe, expect, test } from 'bun:test';

import { isSelfHostOperatorEmail, selfHostOperatorAllowlist } from './self-host-operator';

/**
 * `isPlatformAdmin` answers "may this person configure the server", and TWO
 * different populations satisfy it:
 *
 *  - a **self-host operator**, admitted by `KORTIX_PLATFORM_ADMIN_EMAILS`. The
 *    managed-git org is THEIR org.
 *  - a **cloud platform admin**, admitted by a `platform_user_roles` row. On
 *    cloud, `MANAGED_GIT_GITHUB_OWNER` is `managed-kortix`, which holds every
 *    customer's project repository.
 *
 * The managed-git PAT import path (the synthetic `pat` installation) lists that
 * org wholesale. Gating it on `isPlatformAdmin` therefore offered every
 * customer's private repo to any Kortix staff admin, one click from `/new` —
 * reported 2026-08-29 as "why can I import anyone else's project".
 *
 * `isSelfHostOperatorEmail` is the narrower question that path must ask
 * instead: it is true ONLY via the env allowlist, which `getPlatformRole`'s own
 * doc comment says is "Unset on cloud, so it is inert there".
 */
describe('selfHostOperatorAllowlist', () => {
  test('is empty when the env var is unset — i.e. on cloud', () => {
    expect(selfHostOperatorAllowlist(undefined)).toEqual([]);
    expect(selfHostOperatorAllowlist('')).toEqual([]);
    expect(selfHostOperatorAllowlist('   ')).toEqual([]);
  });

  test('parses a comma-separated list, normalizing case and spacing', () => {
    expect(selfHostOperatorAllowlist(' Ops@Example.com , second@example.com ')).toEqual([
      'ops@example.com',
      'second@example.com',
    ]);
  });

  test('drops empty entries rather than admitting a blank email', () => {
    // A trailing comma must not produce an '' entry that an empty/absent email
    // could then match.
    expect(selfHostOperatorAllowlist('ops@example.com,,')).toEqual(['ops@example.com']);
  });
});

describe('isSelfHostOperatorEmail', () => {
  test('true only for an email on the allowlist', () => {
    const list = 'ops@example.com';
    expect(isSelfHostOperatorEmail('ops@example.com', list)).toBe(true);
    expect(isSelfHostOperatorEmail('OPS@Example.com', list)).toBe(true);
    expect(isSelfHostOperatorEmail('someone@example.com', list)).toBe(false);
  });

  test('THE REGRESSION: false on cloud, where the allowlist is unset', () => {
    // This is the whole point. A Kortix staff platform admin has a
    // `platform_user_roles` row and no allowlist entry, so the managed-org
    // import path must not open for them.
    expect(isSelfHostOperatorEmail('staff@kortix.ai', undefined)).toBe(false);
    expect(isSelfHostOperatorEmail('staff@kortix.ai', '')).toBe(false);
  });

  test('false for a missing email, never a blank match', () => {
    expect(isSelfHostOperatorEmail(null, 'ops@example.com')).toBe(false);
    expect(isSelfHostOperatorEmail(undefined, 'ops@example.com')).toBe(false);
    expect(isSelfHostOperatorEmail('', 'ops@example.com')).toBe(false);
    expect(isSelfHostOperatorEmail('   ', 'ops@example.com')).toBe(false);
  });
});
