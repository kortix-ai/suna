import { describe, expect, test } from 'bun:test';

import { isSystemDirectoryPath } from './system-dir';

describe('use-file-content system-directory guard', () => {
  test('flags elevated system directories that must never be read as content', () => {
    // GET /file/content?path=.opencode always 400s ("Path is a directory") —
    // these must be disabled so they stop flooding the session page.
    expect(isSystemDirectoryPath('.opencode')).toBe(true);
    expect(isSystemDirectoryPath('.kortix')).toBe(true);
    expect(isSystemDirectoryPath('.git')).toBe(true);
  });

  test('normalizes leading/trailing slashes', () => {
    expect(isSystemDirectoryPath('/.opencode')).toBe(true);
    expect(isSystemDirectoryPath('.opencode/')).toBe(true);
    expect(isSystemDirectoryPath('/.kortix/')).toBe(true);
  });

  test('does NOT flag real files inside those directories', () => {
    expect(isSystemDirectoryPath('.opencode/opencode.json')).toBe(false);
    expect(isSystemDirectoryPath('.kortix/agents/veyris.md')).toBe(false);
    expect(isSystemDirectoryPath('workspace/report.md')).toBe(false);
    expect(isSystemDirectoryPath(null)).toBe(false);
    expect(isSystemDirectoryPath('')).toBe(false);
  });
});
