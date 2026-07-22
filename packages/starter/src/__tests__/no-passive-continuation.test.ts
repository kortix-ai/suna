import { describe, expect, test } from 'bun:test';

import { getStarterFiles } from '../index';

describe('starter passive continuation policy', () => {
  test('does not install or register the passive continuation plugin', () => {
    const files = getStarterFiles({ projectName: 'Test Project', template: 'minimal' });
    const paths = files.map((file) => file.path);
    const opencodeConfig = files.find((file) => file.path === '.opencode/opencode.jsonc');

    expect(paths.some((path) => path.startsWith('.opencode/continuation/'))).toBe(false);
    expect(opencodeConfig).toBeDefined();
    expect(opencodeConfig?.content).not.toContain('"plugin"');
    expect(opencodeConfig?.content).not.toContain('kortix-continuation');
  });
});
