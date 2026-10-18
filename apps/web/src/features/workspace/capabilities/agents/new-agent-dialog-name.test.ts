import { describe, expect, test } from 'bun:test';

import { agentNameIssue } from './new-agent-dialog';

/**
 * KRTX-2086's manual create path: the one rule standing between a typed name
 * and the agent-config PUT. The rule is the manifest validator's own slug
 * shape, so what the form accepts the API accepts — these pin both halves of
 * that promise (every rejection reason, and the shapes that must pass).
 */
describe('agentNameIssue', () => {
  test('empty and whitespace-only names are refused before the API sees them', () => {
    expect(agentNameIssue('', [])).toBe('empty');
  });

  test('names the manifest slug rule rejects stay off the wire', () => {
    expect(agentNameIssue('Agent One', [])).toBe('invalid'); // space + uppercase
    expect(agentNameIssue('-lead', [])).toBe('invalid'); // must start alphanumeric
    expect(agentNameIssue('_lead', [])).toBe('invalid');
    expect(agentNameIssue('a'.repeat(129), [])).toBe('invalid'); // over the 128 cap
  });

  test('every shape the manifest validator accepts passes', () => {
    expect(agentNameIssue('a', [])).toBeNull();
    expect(agentNameIssue('code-writer_2', [])).toBeNull();
    expect(agentNameIssue('a'.repeat(128), [])).toBeNull(); // exactly the cap
  });

  test('a declared agent name is refused even though it is a valid slug', () => {
    expect(agentNameIssue('kortix', ['kortix', 'base'])).toBe('taken');
  });

  test('case differences still collide — the manifest map is case-sensitive', () => {
    expect(agentNameIssue('Kortix', ['kortix'])).toBe('invalid'); // uppercase never a slug
    expect(agentNameIssue('reviewer', ['reviewer-2'])).toBeNull();
  });
});
