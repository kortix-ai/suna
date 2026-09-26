import { describe, expect, test } from 'bun:test';
import { dcpIdsLabel, genericArgs, genericSubtitle, genericTriggerArgs, parseToolName } from './projects-generic';

// apps/web `tool/generic-tool.tsx`: the fallback row for any tool without its
// own renderer.

describe('parseToolName', () => {
  test('`server/tool` splits the server off and humanizes the display', () => {
    expect(parseToolName('linear/create_issue')).toEqual({ server: 'linear', display: 'Create Issue' });
  });

  test('`mcp__server__tool` humanizes through the one shared humanizer, no server arg', () => {
    expect(parseToolName('mcp__linear__create_issue')).toEqual({ server: null, display: 'Create Issue' });
  });
});

describe('genericSubtitle', () => {
  test('the first non-empty known key, in web order', () => {
    expect(genericSubtitle({ path: '/a', description: 'Do it' })).toBe('Do it');
    expect(genericSubtitle({ query: '', url: 'https://x.dev' })).toBe('https://x.dev');
    expect(genericSubtitle({ count: 3 })).toBeUndefined();
  });

  test('longer than 80 characters is cut to 77 plus an ellipsis', () => {
    const s = genericSubtitle({ prompt: 'a'.repeat(100) });
    expect(s).toBe(`${'a'.repeat(77)}…`);
  });
});

describe('genericArgs / genericTriggerArgs', () => {
  test('scalar non-subtitle inputs as key=value, at most 3', () => {
    expect(genericArgs({ description: 'x', a: 1, b: true, c: 's', d: 'dropped', e: { nested: 1 } })).toEqual([
      'a=1',
      'b=true',
      'c=s',
    ]);
  });

  test('the server leads the args; no server and no args is undefined', () => {
    expect(genericTriggerArgs('linear', ['a=1'])).toEqual(['linear', 'a=1']);
    expect(genericTriggerArgs(null, ['a=1'])).toEqual(['a=1']);
    expect(genericTriggerArgs(null, [])).toBeUndefined();
  });
});

describe('dcpIdsLabel', () => {
  test('"N tools" when ids exist, else nothing', () => {
    expect(dcpIdsLabel(['a', 'b'])).toBe('2 tools');
    expect(dcpIdsLabel([])).toBeNull();
    expect(dcpIdsLabel(undefined)).toBeNull();
  });
});
