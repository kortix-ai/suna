import { describe, expect, test } from 'bun:test';
import { connectorDeniedForAgent } from '../executor/share';

// The pure connector-side agent gate the executor applies in connectorUsable():
// is a connector restricted to specific agents DENIED to the running agent?
// Mirrors the secret gate (secretNamesDeniedForAgent) so the two axes agree on
// identity. NULL/empty scope = all agents; a scope denies anyone not in it,
// including a null/unidentifiable agent (fail closed).
describe('connectorDeniedForAgent', () => {
  test('an all-agents connector (null/empty scope) is never denied', () => {
    expect(connectorDeniedForAgent(null, 'builder')).toBe(false);
    expect(connectorDeniedForAgent(undefined, 'builder')).toBe(false);
    expect(connectorDeniedForAgent([], 'builder')).toBe(false);
    // Even with no identifiable agent, an unscoped connector passes.
    expect(connectorDeniedForAgent(null, null)).toBe(false);
  });

  test('a scoped connector denies an agent NOT in its list', () => {
    expect(connectorDeniedForAgent(['payments-bot'], 'builder')).toBe(true);
  });

  test('a scoped connector allows an agent IN its list', () => {
    expect(connectorDeniedForAgent(['payments-bot', 'builder'], 'builder')).toBe(false);
  });

  test('a scoped connector denies a null / unidentifiable agent (fail closed)', () => {
    expect(connectorDeniedForAgent(['payments-bot'], null)).toBe(true);
    expect(connectorDeniedForAgent(['payments-bot'], '')).toBe(true);
  });

  test('the fully-privileged `default` agent is denied a connector scoped to others', () => {
    // Consistency with secrets: the call gate resolves projectSessions.agent_name
    // ('default' for the default agent), so it is treated as a concrete name and
    // excluded from a scope that does not list it.
    expect(connectorDeniedForAgent(['pr-bot'], 'default')).toBe(true);
    expect(connectorDeniedForAgent(['pr-bot', 'default'], 'default')).toBe(false);
  });

  test('agent-name matching is exact / case-sensitive', () => {
    expect(connectorDeniedForAgent(['builder'], 'Builder')).toBe(true);
    expect(connectorDeniedForAgent(['builder'], 'builder')).toBe(false);
  });
});
