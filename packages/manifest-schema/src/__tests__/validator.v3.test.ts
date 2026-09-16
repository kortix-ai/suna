import { describe, expect, test } from 'bun:test';
import { validateManifest } from '../index.ts';

describe('manifest version selects the runtime', () => {
  test.each([
    [2, undefined, true],
    [2, 'opencode', true],
    [2, 'pi', false],
    [2, null, false],
    [3, undefined, true],
    [3, 'pi', true],
    [3, 'opencode', false],
    [3, null, false],
  ] as const)('version %s with runtime %s is valid: %s', (version, runtime, valid) => {
    const result = validateManifest({
      kortix_version: version,
      default_agent: 'support',
      agents: { support: {} },
      ...(runtime === undefined ? {} : { runtime }),
    }, 'yaml');
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors.length === 0).toBe(valid);
    if (!valid) expect(errors).toContainEqual(expect.objectContaining({ path: 'runtime' }));
  });
});
