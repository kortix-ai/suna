import { describe, expect, test } from 'bun:test';

import { shouldReprovisionFailedJustAvpsSandbox } from '../platform/services/sandbox-reinitialize';

describe('sandbox cloud recovery decisions', () => {
  test('reprovisions errored sandboxes with no provider machine id', () => {
    expect(shouldReprovisionFailedJustAvpsSandbox('error', '', null)).toBe(true);
  });

  test('reprovisions errored sandboxes when provider reports removed', () => {
    expect(shouldReprovisionFailedJustAvpsSandbox('error', 'machine_123', 'removed')).toBe(true);
  });

  test('does not reprovision healthy provider machines', () => {
    expect(shouldReprovisionFailedJustAvpsSandbox('error', 'machine_123', 'running')).toBe(false);
    expect(shouldReprovisionFailedJustAvpsSandbox('error', 'machine_123', 'unknown')).toBe(false);
  });

  test('ignores non-error sandboxes', () => {
    expect(shouldReprovisionFailedJustAvpsSandbox('active', 'machine_123', 'removed')).toBe(false);
  });
});
