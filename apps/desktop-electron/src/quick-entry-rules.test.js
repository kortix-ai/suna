const { describe, expect, test } = require('bun:test');

const {
  DEFAULT_SHORTCUT,
  PENDING_TTL_MS,
  freshPrompt,
  normalizeTarget,
  quickEntryBounds,
  resolveShortcut,
  shortcutLabel,
} = require('./quick-entry-rules');

describe('resolveShortcut', () => {
  test('a new profile gets the default, which is not the ⌥Space other AI apps take', () => {
    expect(resolveShortcut(undefined)).toBe('CommandOrControl+Shift+Space');
    expect(DEFAULT_SHORTCUT).not.toBe('Alt+Space');
  });

  test('a saved menu choice is kept, and null keeps the shortcut off', () => {
    expect(resolveShortcut('Alt+Space')).toBe('Alt+Space');
    expect(resolveShortcut('Alt+Shift+Space')).toBe('Alt+Shift+Space');
    expect(resolveShortcut(null)).toBeNull();
  });

  test('a hand-edited or stale value falls back to the default', () => {
    expect(resolveShortcut('Command+Q')).toBe(DEFAULT_SHORTCUT);
    expect(resolveShortcut(42)).toBe(DEFAULT_SHORTCUT);
  });
});

describe('shortcutLabel', () => {
  test('names the keys the way each platform prints them', () => {
    expect(shortcutLabel('CommandOrControl+Shift+Space', 'darwin')).toBe('Command + Shift + Space');
    expect(shortcutLabel('Alt+Space', 'darwin')).toBe('Option + Space');
    expect(shortcutLabel('CommandOrControl+Shift+Space', 'win32')).toBe('Ctrl + Shift + Space');
    expect(shortcutLabel('Alt+Shift+Space', 'linux')).toBe('Alt + Shift + Space');
  });
});

describe('quickEntryBounds', () => {
  test('centers the bar a quarter of the way down the display under the cursor', () => {
    expect(quickEntryBounds({ x: 0, y: 25, width: 1440, height: 875 }, 744, 120)).toEqual({
      x: 348,
      y: 244,
      width: 744,
      height: 120,
    });
  });

  test('stays on a secondary display left of the primary one', () => {
    expect(quickEntryBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, 744, 120)).toEqual({
      x: -1332,
      y: 270,
      width: 744,
      height: 120,
    });
  });
});

describe('freshPrompt', () => {
  const pending = { text: 'Summarize the open PRs', at: 1_000 };

  test('returns the text while the app window can still take it', () => {
    expect(freshPrompt(pending, 1_000)).toBe('Summarize the open PRs');
    expect(freshPrompt(pending, 1_000 + PENDING_TTL_MS)).toBe('Summarize the open PRs');
  });

  test('drops a prompt typed more than ten minutes ago, so an agent never acts on it late', () => {
    expect(freshPrompt(pending, 1_001 + PENDING_TTL_MS)).toBeNull();
    expect(freshPrompt(null, 1_000)).toBeNull();
  });
});

describe('normalizeTarget', () => {
  test('keeps the project id and a trimmed name', () => {
    expect(normalizeTarget({ projectId: 'p1', name: '  Website  ' })).toEqual({ projectId: 'p1', name: 'Website' });
  });

  test('a project with no name yet still targets the project', () => {
    expect(normalizeTarget({ projectId: 'p1', name: '' })).toEqual({ projectId: 'p1', name: null });
    expect(normalizeTarget({ projectId: 'p1' })).toEqual({ projectId: 'p1', name: null });
  });

  test('anything without a project id clears the target', () => {
    expect(normalizeTarget(null)).toBeNull();
    expect(normalizeTarget({ name: 'Website' })).toBeNull();
    expect(normalizeTarget({ projectId: 7 })).toBeNull();
  });

  test('caps both strings, so page script cannot push an unbounded label into the bar', () => {
    const long = 'x'.repeat(500);
    const target = normalizeTarget({ projectId: long, name: long });
    expect(target?.projectId.length).toBe(200);
    expect(target?.name?.length).toBe(200);
  });
});
