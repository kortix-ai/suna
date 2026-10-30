import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_UI } from '../layout/ui-prefs.ts';
import { DEFAULT_PREFS, initialUi, prefsPath, readPrefs, writePrefs } from './prefs.ts';

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

  test('missing or corrupt reads as the defaults: only the tray and the title, not onboarded', () => {
    const dir = scratch();
    expect(readPrefs(join(dir, 'none.json'))).toEqual(DEFAULT_PREFS);
    writeFileSync(join(dir, 'bad.json'), '{not json');
    const bad = readPrefs(join(dir, 'bad.json'));
    expect(bad.ui.sidebar.on).toBe(false);
    expect(bad.onboarded).toBe(false);
  });

  test('the old { sidebar: true } file still opens with the sidebar', () => {
    const path = join(scratch(), 'tui.json');
    writeFileSync(path, '{"sidebar": true}');
    expect(readPrefs(path).ui.sidebar).toEqual({ on: true, side: 'left' });
  });

  test('a write is read back and merges', () => {
    const path = join(scratch(), 'nested', 'tui.json');
    const ui = { ...DEFAULT_UI, info: { on: true, side: 'left' as const } };
    expect(writePrefs({ ui }, path)).toBe(true);
    expect(writePrefs({ onboarded: true }, path)).toBe(true);
    const back = readPrefs(path);
    expect(back.ui.info).toEqual({ on: true, side: 'left' });
    expect(back.onboarded).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).onboarded).toBe(true);
  });

  test('the flag outranks the saved sidebar for one run', () => {
    const saved = { ui: { ...DEFAULT_UI, sidebar: { on: true, side: 'right' as const } }, onboarded: true };
    expect(initialUi({ KORTIX_TUI_SIDEBAR: '0' }, saved).sidebar).toEqual({ on: false, side: 'right' });
    expect(initialUi({ KORTIX_TUI_SIDEBAR: '1' }, DEFAULT_PREFS).sidebar.on).toBe(true);
    expect(initialUi({}, saved).sidebar.on).toBe(true);
  });
});
