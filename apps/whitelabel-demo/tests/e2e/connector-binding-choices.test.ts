import { describe, expect, test } from 'bun:test';
import { connectorBindingNotice } from '../../src/lib/connector-binding';
import { selectConnectorBindingChoices } from '../../src/server/bindable-connections';

const profile = (over: Record<string, unknown> = {}) =>
  ({
    profile_id: 'p1',
    connector_alias: 'gmail',
    owner_type: 'project',
    owner_id: null,
    label: 'Support',
    status: 'active',
    is_default: false,
    metadata: {},
    ...over,
  }) as never;

describe('selectConnectorBindingChoices', () => {
  test('groups by alias, so no connector is privileged over another', () => {
    const choices = selectConnectorBindingChoices([
      profile({ connector_alias: 'slack', profile_id: 'a' }),
      profile({ connector_alias: 'gmail', profile_id: 'b' }),
    ]);
    expect(choices.map((c) => c.alias)).toEqual(['gmail', 'slack']);
    expect(choices.every((c) => c.connections.length === 1)).toBe(true);
  });

  test('an alias only PRIVATE connections exist for is still listed, as unavailable', () => {
    // This is the confusing case: a teammate connected it — to their own
    // account — so it looks connected and cannot be bound. Dropping the alias
    // from the list would leave nothing to explain.
    const [choice] = selectConnectorBindingChoices([
      profile({ owner_type: 'member', owner_id: 'u1' }),
    ]);
    expect(choice!.connections).toEqual([]);
    expect(choice!.unavailable).toBe('private_only');
  });

  test('a revoked TEAM connection is a different ask than a private one', () => {
    const [choice] = selectConnectorBindingChoices([
      profile({ status: 'revoked' }),
    ]);
    expect(choice!.unavailable).toBe('team_connection_inactive');
  });

  test('a bindable connection wins over any unbindable sibling on the same alias', () => {
    const [choice] = selectConnectorBindingChoices([
      profile({ profile_id: 'mine', owner_type: 'member', owner_id: 'u1' }),
      profile({ profile_id: 'team', label: 'Team inbox' }),
    ]);
    expect(choice!.unavailable).toBeNull();
    expect(choice!.connections.map((c) => c.authorizationId)).toEqual(['team']);
  });

  test('no profiles is no connectors, not a crash', () => {
    expect(selectConnectorBindingChoices(undefined)).toEqual([]);
  });
});

describe('connectorBindingNotice', () => {
  const choiceFor = (over: Record<string, unknown>) =>
    ({
      alias: 'gmail',
      connections: [],
      unavailable: 'private_only',
      ...over,
    }) as never;

  test('a bindable alias has no notice — the picker speaks for itself', () => {
    expect(
      connectorBindingNotice(
        choiceFor({
          unavailable: null,
          connections: [
            {
              authorizationId: 'p',
              connectorAlias: 'gmail',
              label: 'Support',
              isDefault: true,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  test('the private-only case points at a TEAMMATE, not at the reader', () => {
    const notice = connectorBindingNotice(choiceFor({}))!;
    expect(notice.detail).toContain('teammate');
    expect(notice.detail).toContain('own accounts');
  });

  test('a revoked team connection asks for a reconnect, not a first-time share', () => {
    const notice = connectorBindingNotice(
      choiceFor({ unavailable: 'team_connection_inactive' }),
    )!;
    expect(notice.detail).toContain('reconnect');
  });

  test('neither case offers a self-connect action', () => {
    // A wrapper credential has no personal upstream identity, and the
    // interactive flow that would connect one is refused for it outright
    // (403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY) — so a "connect it yourself"
    // button could only ever lead to that refusal.
    for (const unavailable of ['private_only', 'team_connection_inactive']) {
      expect(
        connectorBindingNotice(choiceFor({ unavailable }))!.selfServiceAction,
      ).toBeNull();
    }
  });

  test('no notice ever tells the reader to connect the account themselves', () => {
    for (const unavailable of ['private_only', 'team_connection_inactive']) {
      const notice = connectorBindingNotice(choiceFor({ unavailable }))!;
      expect(`${notice.title} ${notice.detail}`.toLowerCase()).not.toContain(
        'connect your',
      );
    }
  });
});

describe('unavailable reason must not mislabel a shared connection (F4)', () => {
  const profile = (owner: string, status = 'active') =>
    ({
      profile_id: `p-${owner}`,
      connector_alias: 'gmail',
      label: owner,
      owner_type: owner,
      status,
      is_default: false,
    }) as never;

  test('an EXTERNAL profile is not "private only" — channel installs mint those', () => {
    // executor/sync.ts inserts owner_type:'external' profiles for channel/inbox
    // installs, and the platform WILL bind them for a caller who may manage
    // system profiles. Calling that "only connected to people's own accounts"
    // is false AND names an action — ask a teammate to share it — that fixes
    // nothing.
    const choices = selectConnectorBindingChoices([
      profile('external', 'revoked'),
    ]);
    expect(choices[0]?.unavailable).toBe('team_connection_inactive');
  });

  test('only a MEMBER-owned connection is genuinely private to one person', () => {
    const choices = selectConnectorBindingChoices([
      profile('member', 'revoked'),
    ]);
    expect(choices[0]?.unavailable).toBe('private_only');
  });

  test('an active team connection is offered, not reported unavailable', () => {
    const choices = selectConnectorBindingChoices([profile('project')]);
    expect(choices[0]?.unavailable).toBeNull();
    expect(choices[0]?.connections).toHaveLength(1);
  });
});
