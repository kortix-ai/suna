import { describe, expect, test } from 'bun:test';

import { agentConnectorAccess, connectorRuleSetUsage, manifestAgentGrants, withConnectorGrant } from './agent-access';

const MANIFEST = `kortix_version: 2
connectors:
  - slug: gmail
    policy_sets:
      read_only: { policies: [] }
      outreach: { policies: [] }
agents:
  support:
    connectors: [gmail, linear]
    policy_sets: { gmail: read_only }
  ops:
    connectors: all
  writer: {}
`;

describe('manifestAgentGrants', () => {
  test('reads each agent grant and set', () => {
    const grants = manifestAgentGrants(MANIFEST)!;
    expect(agentConnectorAccess(grants.support, 'gmail')).toEqual({ granted: true, policySet: 'read_only' });
    expect(agentConnectorAccess(grants.ops, 'gmail')).toEqual({ granted: true, policySet: null });
    expect(agentConnectorAccess(grants.writer, 'gmail')).toEqual({ granted: false, policySet: null });
  });
  test('a v1 or unparsable manifest is null', () => {
    expect(manifestAgentGrants('kortix_version = 1\n')).toBeNull();
    expect(manifestAgentGrants(null)).toBeNull();
  });
});

describe('withConnectorGrant', () => {
  const grants = manifestAgentGrants(MANIFEST)!;
  test('adds and removes one slug', () => {
    expect(withConnectorGrant(grants.support, 'slack', true, [])).toEqual(['gmail', 'linear', 'slack']);
    expect(withConnectorGrant(grants.support, 'gmail', false, [])).toEqual(['linear']);
  });
  test('taking one from all lists the others', () => {
    expect(withConnectorGrant(grants.ops, 'gmail', false, ['gmail', 'linear'])).toEqual(['linear']);
    expect(withConnectorGrant(grants.ops, 'gmail', true, ['gmail'])).toBe('all');
  });
});

describe('connectorRuleSetUsage', () => {
  test('each set with the number of agents that use it', () => {
    expect(connectorRuleSetUsage(MANIFEST)).toEqual({
      gmail: [
        { name: 'read_only', agents: 1 },
        { name: 'outreach', agents: 0 },
      ],
    });
  });
});
