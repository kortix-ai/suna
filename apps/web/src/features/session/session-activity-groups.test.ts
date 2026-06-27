import { describe, expect, test } from 'bun:test';

import {
  isShellActivityTool,
  normalizeActivityToolName,
  shellActivityGroupLabel,
} from './session-activity-groups';

describe('session activity groups', () => {
  test('normalizes OpenCode tool names', () => {
    expect(normalizeActivityToolName('oc-bash')).toBe('bash');
    expect(normalizeActivityToolName('web-search')).toBe('web_search');
    expect(normalizeActivityToolName(undefined)).toBe('');
  });

  test('detects shell groups only for bash tools', () => {
    expect(isShellActivityTool('bash')).toBe(true);
    expect(isShellActivityTool('oc-bash')).toBe(true);
    expect(isShellActivityTool('web-search')).toBe(false);
    expect(isShellActivityTool(undefined)).toBe(false);
  });

  test('formats shell group labels for completed and running commands', () => {
    expect(shellActivityGroupLabel(1, false)).toBe('Ran 1 command');
    expect(shellActivityGroupLabel(2, false)).toBe('Ran 2 commands');
    expect(shellActivityGroupLabel(3, true)).toBe('Running 3 commands');
  });
});
