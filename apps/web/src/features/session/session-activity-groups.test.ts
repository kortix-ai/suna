import { describe, expect, test } from 'bun:test';

import {
  isInvisibleActivityPart,
  isNoGroupActivityTool,
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

  test('never groups write or show tools', () => {
    expect(isNoGroupActivityTool('write')).toBe(true);
    expect(isNoGroupActivityTool('show')).toBe(true);
    expect(isNoGroupActivityTool('show-user')).toBe(true);
    expect(isNoGroupActivityTool('oc-show')).toBe(true);
    // grouped tools stay groupable
    expect(isNoGroupActivityTool('bash')).toBe(false);
    expect(isNoGroupActivityTool('web-search')).toBe(false);
    expect(isNoGroupActivityTool(undefined)).toBe(false);
  });

  test('treats blank text and snapshot/patch bookkeeping as invisible', () => {
    expect(isInvisibleActivityPart({ type: 'snapshot' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'patch' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'text', text: '   ' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'text', text: '' })).toBe(true);
    // real content and other parts are visible and DO break a tool run
    expect(isInvisibleActivityPart({ type: 'text', text: 'Now running QA' })).toBe(false);
    expect(isInvisibleActivityPart({ type: 'tool' })).toBe(false);
    expect(isInvisibleActivityPart({ type: 'compaction' })).toBe(false);
  });
});
