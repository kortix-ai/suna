/**
 * Non-escalation: a governed agent writes into an agent grant only what it
 * holds itself. Pure half — the writer's permission check is injected.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import { findGrantEscalation, grantAdditions } from './agent-grant-ceiling';

const grant = (agent: string, over: Partial<AgentGrant> = {}): AgentGrant => ({
  agent,
  permissions: [],
  connectors: [],
  env: [],
  ...over,
});

const writer = grant('merger', {
  permissions: ['project.read', 'project.agent.write', 'project.gitops.merge'],
  connectors: ['github'],
  env: ['GH_TOKEN'],
  apps: ['dash'],
});
const holds = new Set(writer.permissions as string[]);
const ALL = ['project.read', 'project.agent.write', 'project.gitops.merge', 'project.delete'];

async function escalation(before: AgentGrant[], after: AgentGrant[]) {
  return findGrantEscalation({
    writer,
    writerMayPerform: async (action) => holds.has(action),
    allPermissions: ALL,
    before: new Map(before.map((g) => [g.agent, g])),
    after: new Map(after.map((g) => [g.agent, g])),
  });
}

describe('grantAdditions', () => {
  test('lists only what the new grant adds, per dimension', () => {
    const before = grant('a', { permissions: ['project.read'], env: ['A'], apps: ['x'] });
    const after = grant('a', { permissions: ['project.read', 'project.delete'], env: ['a', 'B'], apps: ['X', 'y'] });
    expect(grantAdditions(before, after)).toEqual({
      permissions: ['project.delete'],
      connectors: [],
      secrets: ['B'],
      apps: ['y'],
    });
  });

  test('widening to all adds all; narrowing from all adds nothing', () => {
    expect(grantAdditions(grant('a'), grant('a', { permissions: 'all' })).permissions).toBe('all');
    expect(grantAdditions(grant('a', { connectors: 'all' }), grant('a', { connectors: ['x'] })).connectors).toEqual([]);
    expect(grantAdditions(grant('a', { permissions: 'all' }), grant('a', { permissions: 'all' })).permissions).toEqual([]);
  });

  test('a new agent adds its whole grant; an omitted secrets list means all', () => {
    const added = grantAdditions(undefined, { agent: 'n', permissions: ['project.read'], connectors: [] });
    expect(added.permissions).toEqual(['project.read']);
    expect(added.secrets).toBe('all');
    expect(added.apps).toEqual([]);
  });

  test('"*" inside a list counts as all', () => {
    expect(grantAdditions(grant('a'), grant('a', { apps: ['*'] })).apps).toBe('all');
  });
});

describe('findGrantEscalation', () => {
  test('raising itself to all is refused, naming a permission it lacks', async () => {
    expect(await escalation([writer], [{ ...writer, permissions: 'all' }])).toEqual({
      target: 'merger',
      dimension: 'permissions',
      item: 'project.delete',
    });
  });

  test('granting another agent a subset of its own permissions passes', async () => {
    const helper = grant('helper', { permissions: ['project.read', 'project.agent.write'], connectors: ['github'] });
    expect(await escalation([writer], [writer, helper])).toBeNull();
  });

  test('a secret, connector or App it does not hold is refused', async () => {
    expect(await escalation([writer], [{ ...writer, env: ['GH_TOKEN', 'STRIPE_KEY'] }])).toEqual({
      target: 'merger',
      dimension: 'secrets',
      item: 'STRIPE_KEY',
    });
    expect(await escalation([], [grant('n', { connectors: ['slack'] })])).toMatchObject({ dimension: 'connectors', item: 'slack' });
    expect(await escalation([], [grant('n', { apps: 'all' })])).toMatchObject({ dimension: 'apps', item: 'all' });
  });

  test('secrets compare case-insensitively; an omitted secrets list needs a writer holding all', async () => {
    expect(await escalation([], [grant('n', { env: ['gh_token'] })])).toBeNull();
    expect(await escalation([], [{ agent: 'n', permissions: [], connectors: [] }])).toMatchObject({
      dimension: 'secrets',
      item: 'all',
    });
  });

  test('narrowing or removing an agent never escalates', async () => {
    const wide = grant('w', { permissions: 'all', connectors: 'all', env: 'all', apps: 'all' });
    expect(await escalation([writer, wide], [writer, grant('w', { permissions: ['project.read'] })])).toBeNull();
    expect(await escalation([writer, wide], [writer])).toBeNull();
  });

  test('a writer holding all may grant all', async () => {
    const full = grant('root', { permissions: 'all', connectors: 'all', env: 'all', apps: 'all' });
    const result = await findGrantEscalation({
      writer: full,
      writerMayPerform: async () => true,
      allPermissions: ALL,
      before: new Map(),
      after: new Map([['n', grant('n', { permissions: 'all', connectors: 'all', env: 'all', apps: 'all' })]]),
    });
    expect(result).toBeNull();
  });
});
