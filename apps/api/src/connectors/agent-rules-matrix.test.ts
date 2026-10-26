import { describe, expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import { rulesMatrix } from './agent-rules-matrix';

const grant = (connectors: AgentGrant['connectors'], policySets?: Record<string, string>) =>
  ({ connectors, permissions: [], secrets: [], ...(policySets ? { policySets } : {}) }) as unknown as AgentGrant;

describe('rulesMatrix', () => {
  test('each agent × connector: granted, its rule set, and a set the connector lacks', () => {
    const matrix = rulesMatrix(
      [
        { slug: 'gmail', name: 'Gmail', policy_sets: ['read_only'] },
        { slug: 'linear', name: 'Linear', policy_sets: [] },
      ],
      new Map([
        ['support', grant(['gmail'], { gmail: 'read_only' })],
        ['ops', grant('all', { '*': 'triage' })],
      ]),
    );
    expect(matrix.connectors).toEqual([
      { slug: 'gmail', name: 'Gmail', policy_sets: ['read_only'] },
      { slug: 'linear', name: 'Linear', policy_sets: [] },
    ]);
    expect(matrix.agents).toEqual([
      {
        agent: 'ops',
        cells: {
          gmail: { granted: true, policy_set: 'triage', policy_set_missing: true },
          linear: { granted: true, policy_set: 'triage', policy_set_missing: true },
        },
      },
      {
        agent: 'support',
        cells: {
          gmail: { granted: true, policy_set: 'read_only', policy_set_missing: false },
          linear: { granted: false, policy_set: null, policy_set_missing: false },
        },
      },
    ]);
  });
});
