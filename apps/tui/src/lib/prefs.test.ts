import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PREFS, initialSidebarShown, prefsPath, readPrefs, writePrefs } from './prefs.ts';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-tui-prefs-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('tui.json', () => {
  test('lives beside the CLI config file', () => {
    expect(prefsPath({ KORTIX_CONFIG_FILE: '/x/kortix/config.json' })).toBe('/x/kortix/tui.json');
  });

  test('missing or corrupt reads as the defaults: sidebar hidden', () => {
    const dir = scratch();
    expect(readPrefs(join(dir, 'none.json'))).toEqual(DEFAULT_PREFS);
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readPrefs(join(dir, 'bad.json')).sidebar).toBe(false);
  });

  test('a write is read back and merges', () => {
    const path = join(scratch(), 'nested', 'tui.json');
    expect(writePrefs({ sidebar: true }, path)).toBe(true);
    expect(readPrefs(path).sidebar).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ sidebar: true });
  });

  test('the flag outranks the saved choice', () => {
    expect(initialSidebarShown({ KORTIX_TUI_SIDEBAR: '0' }, { sidebar: true })).toBe(false);
    expect(initialSidebarShown({ KORTIX_TUI_SIDEBAR: '1' }, { sidebar: false })).toBe(true);
    expect(initialSidebarShown({}, { sidebar: true })).toBe(true);
    expect(initialSidebarShown({}, { sidebar: false })).toBe(false);
  });
});
