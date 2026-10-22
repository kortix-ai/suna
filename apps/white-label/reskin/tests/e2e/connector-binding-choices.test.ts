import { describe, expect, test } from 'bun:test';
import { selectConnectorBindingChoices } from '../../src/server/bindable-connections';

const connection = (over: Record<string, unknown> = {}) =>
  ({
    connection_id: 'p1',
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
      connection({ connector_alias: 'slack', connection_id: 'a' }),
      connection({ connector_alias: 'gmail', connection_id: 'b' }),
    ]);
    expect(choices.map((c) => c.alias)).toEqual(['gmail', 'slack']);
    expect(choices.every((c) => c.connections.length === 1)).toBe(true);
  });

  test('an alias only PRIVATE connections exist for is still listed, as unavailable', () => {
    // This is the confusing case: a teammate connected it — to their own
    // account — so it looks connected and cannot be bound. Dropping the alias
    // from the list would leave nothing to explain.
    const [choice] = selectConnectorBindingChoices([
      connection({ owner_type: 'member', owner_id: 'u1' }),
    ]);
    expect(choice!.connections).toEqual([]);
    expect(choice!.unavailable).toBe('private_only');
  });

  test('a revoked project connection is a different ask than a private one', () => {
    const [choice] = selectConnectorBindingChoices([
      connection({ status: 'revoked' }),
    ]);
    expect(choice!.unavailable).toBe('project_connection_inactive');
  });

  test('a bindable connection wins over any unbindable sibling on the same alias', () => {
    const [choice] = selectConnectorBindingChoices([
      connection({ connection_id: 'mine', owner_type: 'member', owner_id: 'u1' }),
      connection({ connection_id: 'project', label: 'Project inbox' }),
    ]);
    expect(choice!.unavailable).toBeNull();
    expect(choice!.connections.map((c) => c.connectionId)).toEqual(['project']);
  });

  test('no connections is no connectors, not a crash', () => {
    expect(selectConnectorBindingChoices(undefined)).toEqual([]);
  });
});

describe('unavailable reason must not mislabel a shared connection (F4)', () => {
  const connection = (owner: string, status = 'active') =>
    ({
      connection_id: `p-${owner}`,
      connector_alias: 'gmail',
      label: owner,
      owner_type: owner,
      status,
      is_default: false,
    }) as never;

  test('an EXTERNAL connection is not "private only" — channel installs mint those', () => {
    // connector/sync.ts inserts owner_type:'external' connections for channel/inbox
    // installs, and the platform WILL bind them for a caller who may manage
    // system connections. Calling that "only connected to people's own accounts"
    // is false AND names an action — ask a teammate to share it — that fixes
    // nothing.
    const choices = selectConnectorBindingChoices([
      connection('external', 'revoked'),
    ]);
    expect(choices[0]?.unavailable).toBe('project_connection_inactive');
  });

  test('only a MEMBER-owned connection is genuinely private to one person', () => {
    const choices = selectConnectorBindingChoices([
      connection('member', 'revoked'),
    ]);
    expect(choices[0]?.unavailable).toBe('private_only');
  });

  test('an active project connection is offered, not reported unavailable', () => {
    const choices = selectConnectorBindingChoices([connection('project')]);
    expect(choices[0]?.unavailable).toBeNull();
    expect(choices[0]?.connections).toHaveLength(1);
  });
});
