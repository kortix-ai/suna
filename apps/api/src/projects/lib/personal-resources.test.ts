/**
 * Spec docs/specs/2026-09-22-agents-as-principals.md §2.3: a personal resource
 * is reachable by an agent session only when owner == on_behalf_of AND the
 * session is private. Flag OFF keeps each caller's legacy user.
 */
import { describe, expect, test } from 'bun:test';
import type { Actor } from '../../iam/actor';
import { actorPersonalScope, filterPersonalTunnelOwners, personalResourceOwner } from './personal-resources';

const HUMAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LAUNCHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('personalResourceOwner', () => {
  test('flag OFF / ungoverned: the legacy user is returned unchanged', () => {
    expect(
      personalResourceOwner({ agentPrincipal: false, legacyUserId: LAUNCHER, onBehalfOfUserId: null, visibility: 'project' }),
    ).toBe(LAUNCHER);
    expect(
      personalResourceOwner({ agentPrincipal: false, legacyUserId: null, onBehalfOfUserId: HUMAN, visibility: 'private' }),
    ).toBeNull();
  });

  test("agent principal, private session: the on-behalf-of human, never the launcher", () => {
    expect(
      personalResourceOwner({ agentPrincipal: true, legacyUserId: LAUNCHER, onBehalfOfUserId: HUMAN, visibility: 'private' }),
    ).toBe(HUMAN);
  });

  test('agent principal, shared session: none', () => {
    for (const visibility of ['project', 'restricted', null] as const) {
      expect(
        personalResourceOwner({ agentPrincipal: true, legacyUserId: LAUNCHER, onBehalfOfUserId: HUMAN, visibility }),
      ).toBeNull();
    }
  });

  test('agent principal, unattended or cleared (on_behalf_of null): none', () => {
    expect(
      personalResourceOwner({ agentPrincipal: true, legacyUserId: LAUNCHER, onBehalfOfUserId: null, visibility: 'private' }),
    ).toBeNull();
  });
});

function agentActor(overrides: Partial<Extract<Actor['credential'], { kind: 'agent_session' }>> = {}): Actor {
  return {
    userId: LAUNCHER,
    accountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ctx: {},
    credential: {
      kind: 'agent_session',
      tokenId: 'tok',
      projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      agentGrant: null,
      serviceAccountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      activated: false,
      agentPrincipal: true,
      onBehalfOfUserId: HUMAN,
      ...overrides,
    },
  };
}

describe('actorPersonalScope', () => {
  test('a human or legacy agent credential is not an agent principal', () => {
    expect(actorPersonalScope(null)).toEqual({ agentPrincipal: false, onBehalfOfUserId: null });
    expect(
      actorPersonalScope({ userId: HUMAN, accountId: 'x', ctx: {}, credential: { kind: 'jwt' } }),
    ).toEqual({ agentPrincipal: false, onBehalfOfUserId: null });
    expect(actorPersonalScope(agentActor({ agentPrincipal: false }))).toEqual({
      agentPrincipal: false,
      onBehalfOfUserId: null,
    });
  });

  test('an agent principal carries on_behalf_of from the credential', () => {
    expect(actorPersonalScope(agentActor())).toEqual({ agentPrincipal: true, onBehalfOfUserId: HUMAN });
  });

  test('the fresh per-request value wins over the memoized credential (a clear takes effect at once)', () => {
    expect(actorPersonalScope(agentActor(), null)).toEqual({ agentPrincipal: true, onBehalfOfUserId: null });
  });
});

describe('filterPersonalTunnelOwners (own computer)', () => {
  const TEAM = '11111111-1111-4111-8111-111111111111';
  test('keeps the team account and only the personal owner the rule allows', () => {
    expect(
      filterPersonalTunnelOwners({ accountId: TEAM, owners: [TEAM, HUMAN, LAUNCHER], personalOwner: HUMAN }),
    ).toEqual([TEAM, HUMAN]);
  });
  test('no personal owner (unattended, shared, cleared): team machines only', () => {
    expect(filterPersonalTunnelOwners({ accountId: TEAM, owners: [TEAM, HUMAN], personalOwner: null })).toEqual([TEAM]);
    expect(filterPersonalTunnelOwners({ accountId: TEAM, owners: [HUMAN], personalOwner: null })).toEqual([]);
  });
  test('a legacy aggregate (null owners) passes through', () => {
    expect(filterPersonalTunnelOwners({ accountId: TEAM, owners: null, personalOwner: null })).toBeNull();
  });
});
