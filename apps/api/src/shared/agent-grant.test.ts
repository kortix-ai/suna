import { describe, expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import { normalizeAgentGrant } from './agent-grant';

describe('normalizeAgentGrant', () => {
  test('adds an empty knowledge grant to historical stored rows', () => {
    const historical = {
      agent: 'support',
      kortixCli: [],
      connectors: [],
    } as unknown as AgentGrant;

    expect(normalizeAgentGrant(historical)).toEqual({ ...historical, knowledge: [] });
  });

  test('preserves an explicit knowledge grant', () => {
    const grant: AgentGrant = {
      agent: 'support',
      kortixCli: [],
      connectors: [],
      knowledge: ['support-handbook'],
    };

    expect(normalizeAgentGrant(grant)).toEqual(grant);
  });
});
