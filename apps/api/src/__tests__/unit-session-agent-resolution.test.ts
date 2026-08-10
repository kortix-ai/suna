import { describe, expect, test } from 'bun:test';
import { resolveSessionAgentName } from '../workspaces/lib/sessions';

describe('resolveSessionAgentName', () => {
  test('uses an explicit concrete agent before every default', () => {
    expect(
      resolveSessionAgentName({
        requestedAgent: 'writer',
        manifestDefaultAgent: 'veyris',
        mirroredDefaultAgent: 'kortix',
      }),
    ).toBe('writer');
  });

  test('treats the default sentinel as non-binding and trusts the v2 manifest', () => {
    expect(
      resolveSessionAgentName({
        requestedAgent: 'default',
        manifestDefaultAgent: 'veyris',
        mirroredDefaultAgent: 'kortix',
      }),
    ).toBe('veyris');
  });

  test('keeps the database mirror as the legacy fallback when no manifest default exists', () => {
    expect(
      resolveSessionAgentName({
        requestedAgent: null,
        manifestDefaultAgent: null,
        mirroredDefaultAgent: 'kortix',
      }),
    ).toBe('kortix');
  });
});
