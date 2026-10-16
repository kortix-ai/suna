import { describe, expect, test } from 'bun:test';
import { SANDBOX_TRANSITIONS, SESSION_TRANSITIONS } from './status-transitions';

// Table invariants. Every write through the table is proven on real rows in
// __tests__/integration-session-status-transitions.test.ts; these hold for
// every transition, including ones that suite never exercises.
describe('the transition table', () => {
  test('only the archive transitions produce `archived`, and only `restore` leaves it', () => {
    for (const [name, rule] of Object.entries(SANDBOX_TRANSITIONS)) {
      const archives = name === 'archive' || name === 'archiveProvisioning';
      expect(rule.to === 'archived').toBe(archives);
      if (!archives && name !== 'restore') expect(rule.from as readonly string[]).not.toContain('archived');
    }
    // A restored session's archived row becomes a stopped row with no box, never a live one.
    expect(SANDBOX_TRANSITIONS.restore).toEqual({ from: ['archived'], to: 'stopped' });
  });

  test('a deleted session only ever moves toward stopped', () => {
    for (const rule of Object.values(SESSION_TRANSITIONS)) {
      const movesDeleted =
        ('appliesToDeleted' in rule && rule.appliesToDeleted) || ('deletedOnly' in rule && rule.deletedOnly);
      if (movesDeleted) expect(rule.to).toBe('stopped');
    }
  });

  test('only `restore` is limited to a deleted session', () => {
    const deletedOnly = Object.entries(SESSION_TRANSITIONS)
      .filter(([, rule]) => 'deletedOnly' in rule && rule.deletedOnly)
      .map(([name]) => name);
    expect(deletedOnly).toEqual(['restore']);
  });
});
