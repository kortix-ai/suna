import { describe, expect, test } from 'bun:test';

import { distinctAgentGrants, isDirectGrant } from './access-projects-tab';

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
