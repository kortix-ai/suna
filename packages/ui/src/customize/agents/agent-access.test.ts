import { describe, expect, test } from 'bun:test';
import { agentAccess } from './agent-access';

// KRTX-3025: the card said "full tool access" (the agent's own description)
// whatever the configuration granted. The access line is computed from it.
describe('agentAccess', () => {
  test('connectors, secrets and Kortix actions all unscoped read as full access', () => {
    expect(agentAccess({ env: 'all', connectors: 'all', kortix_permissions: 'all', kortix_cli: 'all' })).toEqual({
      kind: 'full',
    });
  });

  test('a scoped agent lists each grant: everything, a count, or none', () => {
    expect(agentAccess({ env: [], connectors: ['shopify', 'gmail'], kortix_permissions: 'all', kortix_cli: 'all' })).toEqual({
      kind: 'scoped',
      parts: [
        { kind: 'connectors', value: 2 },
        { kind: 'secrets', value: 0 },
        { kind: 'actions', value: 'all' },
      ],
    });
  });

  test('an older server without kortix_permissions falls back to kortix_cli', () => {
    const access = agentAccess({ env: 'all', connectors: 'all', kortix_cli: ['project.read'] });
    expect(access).toEqual({
      kind: 'scoped',
      parts: [
        { kind: 'connectors', value: 'all' },
        { kind: 'secrets', value: 'all' },
        { kind: 'actions', value: 1 },
      ],
    });
  });

  test('an agent not governed by kortix.yaml has no access line', () => {
    expect(agentAccess(undefined)).toBeNull();
  });
});
