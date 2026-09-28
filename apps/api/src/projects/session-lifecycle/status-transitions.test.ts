import { describe, expect, test } from 'bun:test';
import { SANDBOX_TRANSITIONS, SESSION_TRANSITIONS } from './status-transitions';

// Table invariants. Every write through the table is proven on real rows in
// __tests__/integration-session-status-transitions.test.ts; these two hold for
// every transition, including ones that suite never exercises.
describe('the transition table', () => {
  test('only the archive transitions produce `archived`, and nothing else leaves it', () => {
    for (const [name, rule] of Object.entries(SANDBOX_TRANSITIONS)) {
      const archives = name === 'archive' || name === 'archiveProvisioning';
      expect(rule.to === 'archived').toBe(archives);
      if (!archives) expect(rule.from as readonly string[]).not.toContain('archived');
    }
  });

  test('a deleted session only ever moves toward stopped', () => {
    for (const rule of Object.values(SESSION_TRANSITIONS)) {
      if ('appliesToDeleted' in rule && rule.appliesToDeleted) expect(rule.to).toBe('stopped');
    }
  });
});
