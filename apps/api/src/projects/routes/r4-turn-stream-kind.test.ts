import { describe, expect, test } from 'bun:test';
import { turnStreamKindField } from './r4-turn-stream-kind';

describe('turnStreamKindField', () => {
  test('passes through every kind the route multiplexes', () => {
    expect(turnStreamKindField('step')).toBe('step');
    expect(turnStreamKindField('answer')).toBe('answer');
    expect(turnStreamKindField('end')).toBe('end');
    expect(turnStreamKindField('turn_end')).toBe('turn_end');
    expect(turnStreamKindField('opencode_session')).toBe('opencode_session');
    expect(turnStreamKindField('execution_lease_discover')).toBe('execution_lease_discover');
    expect(turnStreamKindField('execution_heartbeat')).toBe('execution_heartbeat');
    expect(turnStreamKindField('execution_lease_release')).toBe('execution_lease_release');
  });

  test('falls back to unknown for a missing or non-string kind', () => {
    expect(turnStreamKindField(undefined)).toBe('unknown');
    expect(turnStreamKindField('')).toBe('unknown');
    expect(turnStreamKindField(null)).toBe('unknown');
    expect(turnStreamKindField(42)).toBe('unknown');
  });
});
