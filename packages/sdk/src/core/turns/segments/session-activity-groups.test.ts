import { describe, expect, test } from 'bun:test';

import {
  isEmptyShowPart,
  isInvisibleActivityPart,
  isNoGroupActivityTool,
  isShellActivityTool,
  isStandaloneActivityTool,
  normalizeActivityToolName,
  shellActivityGroupLabel,
  writeActivityGroupLabel,
} from './session-activity-groups';

describe('normalizeActivityToolName', () => {
  test('drops the oc- alias prefix and folds kebab-case to snake_case', () => {
    expect(normalizeActivityToolName('oc-web-search')).toBe('web_search');
    expect(normalizeActivityToolName('bash')).toBe('bash');
  });

  test('an absent name normalizes to the empty string', () => {
    expect(normalizeActivityToolName(undefined)).toBe('');
  });
});

describe('group labels', () => {
  test('shell groups count commands in the right tense', () => {
    expect(isShellActivityTool('oc-bash')).toBe(true);
    expect(isShellActivityTool('read')).toBe(false);
    expect(shellActivityGroupLabel(1, false)).toBe('Ran 1 command');
    expect(shellActivityGroupLabel(3, true)).toBe('Running 3 commands');
    expect(shellActivityGroupLabel(-2, false)).toBe('Ran 0 commands');
  });

  test('write groups count files in the right tense', () => {
    expect(writeActivityGroupLabel(1, true)).toBe('Writing 1 file');
    expect(writeActivityGroupLabel(2, false)).toBe('Wrote 2 files');
  });
});

describe('grouping exemptions', () => {
  test('show and show_user never fold into a group', () => {
    expect(isNoGroupActivityTool('show')).toBe(true);
    expect(isNoGroupActivityTool('show-user')).toBe(true);
    expect(isNoGroupActivityTool('read')).toBe(false);
  });

  test('deliverables and sub-agents always render standalone', () => {
    expect(isStandaloneActivityTool('show')).toBe(true);
    expect(isStandaloneActivityTool('oc-agent-spawn')).toBe(true);
    expect(isStandaloneActivityTool('agent_stop')).toBe(true);
    expect(isStandaloneActivityTool('bash')).toBe(false);
  });
});

describe('isInvisibleActivityPart', () => {
  test('bookkeeping parts and blank text render nothing', () => {
    expect(isInvisibleActivityPart({ type: 'snapshot' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'patch' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'step-start' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'step-finish' })).toBe(true);
    expect(isInvisibleActivityPart({ type: 'text', text: '   ' })).toBe(true);
  });

  test('real text and real tool calls are visible', () => {
    expect(isInvisibleActivityPart({ type: 'text', text: 'hello' })).toBe(false);
    expect(
      isInvisibleActivityPart({ type: 'tool', tool: 'read', state: { status: 'completed' } }),
    ).toBe(false);
  });

  test('a settled show with no artifact is invisible', () => {
    expect(
      isInvisibleActivityPart({
        type: 'tool',
        tool: 'show',
        state: { status: 'completed', input: { type: 'markdown' } },
      }),
    ).toBe(true);
  });
});

describe('isEmptyShowPart', () => {
  test('only a completed show without an artifact is empty', () => {
    expect(isEmptyShowPart({ tool: 'show', state: { status: 'completed', input: {} } })).toBe(true);
    expect(
      isEmptyShowPart({ tool: 'show_user', state: { status: 'completed', input: { path: 'a.md' } } }),
    ).toBe(false);
  });

  test('a running or errored show is never empty — it has content to show', () => {
    expect(isEmptyShowPart({ tool: 'show', state: { status: 'running', input: {} } })).toBe(false);
    expect(isEmptyShowPart({ tool: 'show', state: { status: 'error', input: {} } })).toBe(false);
  });

  test('a carousel is empty only when no item carries an artifact', () => {
    expect(
      isEmptyShowPart({
        tool: 'show',
        state: { status: 'completed', input: { items: '[{"title":"x"}]' } },
      }),
    ).toBe(true);
    expect(
      isEmptyShowPart({
        tool: 'show',
        state: { status: 'completed', input: { items: [{ title: 'x' }, { url: 'https://a.io' }] } },
      }),
    ).toBe(false);
  });

  test('a non-show tool is never an empty show', () => {
    expect(isEmptyShowPart({ tool: 'read', state: { status: 'completed', input: {} } })).toBe(false);
  });
});
