import { describe, expect, test } from 'bun:test';

import { accessVia, agentsMetaPart, distinctAgentGrants, isDirectGrant } from './access-projects-tab';

const grant = (resource_id: string, source: 'direct' | 'group' | 'project') => ({
  grant_id: `${source}-${resource_id}`,
  resource_type: 'agent' as const,
  resource_id,
  expires_at: null,
  source,
});

describe('agent grants on a member row', () => {
  test('only a grant naming the row itself is direct — never a group or everyone', () => {
    expect(isDirectGrant(grant('bot', 'direct'))).toBe(true);
    expect(isDirectGrant(grant('bot', 'group'))).toBe(false);
    expect(isDirectGrant(grant('bot', 'project'))).toBe(false);
  });

  test('one agent reached three ways counts once, and the direct grant wins', () => {
    const distinct = distinctAgentGrants([
      grant('bot', 'project'),
      grant('bot', 'group'),
      grant('bot', 'direct'),
      grant('other', 'project'),
    ]);
    expect(distinct.map((g) => `${g.resource_id}:${g.source}`)).toEqual(['bot:direct', 'other:project']);
  });
});

// The extended access contract passes through the display derivations. The
// rows below mirror what `GET /v1/projects/:id/access` actually serializes
// (member entries carry attribution, group entries omit it); the SDK's
// published response type omits the extended fields, so the host keeps its
// local extension interfaces (out of scope here) and these derivations read
// them with no cast between the mocked response and the display math.
describe('a mocked access response passes through the row derivations', () => {
  const member = (
    over: Partial<Parameters<typeof accessVia>[0]>,
  ): Parameters<typeof accessVia>[0] => ({
    effective_project_role: 'member',
    effective_source: 'direct',
    group_sources: [],
    ...over,
  });

  test('a group-inherited row attributes its head group and counts the rest', () => {
    expect(
      accessVia(
        member({
          effective_source: 'group',
          group_sources: [
            { group_id: 'g1', group_name: 'Engineering', role: 'manager' },
            { group_id: 'g2', group_name: 'Support', role: 'member' },
          ],
        }),
      ),
    ).toBe('via Engineering +1 more');
    expect(
      accessVia(member({ effective_source: 'group', group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'member' }] })),
    ).toBe('via Engineering');
  });

  test('a group-sourced row without group names reads as a plain direct grant', () => {
    expect(accessVia(member({ effective_source: 'group', group_sources: [] }))).toBeNull();
  });

  test('implicit account admin and no-access rows label themselves', () => {
    expect(accessVia(member({ effective_source: 'implicit' }))).toBe('via account admin');
    expect(accessVia(member({ effective_project_role: null, effective_source: null }))).toBe(
      'no access',
    );
    expect(accessVia(member({}))).toBeNull();
  });

  test('the agents meta reads all/none/n-of-m from the granted count', () => {
    expect(agentsMetaPart(0, undefined, true)).toBe('Agents: all');
    expect(agentsMetaPart(0, undefined, false)).toBe('Agents: none');
    expect(agentsMetaPart(3, undefined)).toBe('Agents: 3');
    expect(agentsMetaPart(3, 5)).toBe('Agents: 3 of 5');
  });
});
