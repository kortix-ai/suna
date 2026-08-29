import { describe, expect, test } from 'bun:test';
import { runtimeAgentRosterCacheKey } from './engine';

describe('runtimeAgentRosterCacheKey', () => {
  // The roster was fetched with a hardcoded /workspace while the prompt is
  // forwarded with the producer's own directory. A project-scoped agent that IS
  // valid for the prompt was therefore absent from the roster, the pick was
  // silently dropped, and the turn ran under the default agent.
  test('two directories on one box do not share a roster', () => {
    expect(runtimeAgentRosterCacheKey('box_1', '/workspace')).not.toBe(
      runtimeAgentRosterCacheKey('box_1', '/workspace/sub'),
    );
  });

  test('the same directory on one box shares a roster', () => {
    expect(runtimeAgentRosterCacheKey('box_1', '/workspace')).toBe(
      runtimeAgentRosterCacheKey('box_1', '/workspace'),
    );
  });

  test('the same directory on two boxes does not share a roster', () => {
    expect(runtimeAgentRosterCacheKey('box_1', '/workspace')).not.toBe(
      runtimeAgentRosterCacheKey('box_2', '/workspace'),
    );
  });
});
