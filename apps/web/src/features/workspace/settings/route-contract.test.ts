import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SETTINGS_TABS, legacySectionRedirect, parseSettingsTab } from './settings-tabs';

describe('settings route segments', () => {
  test('every tab id is a usable URL segment', () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab).toMatch(/^[a-z0-9-]+$/);
      expect(parseSettingsTab(tab)).toBe(tab);
    }
  });

  test('an unknown segment does not resolve to a tab', () => {
    expect(parseSettingsTab('nope')).toBeNull();
    expect(parseSettingsTab('Members')).toBeNull();
  });
});

/**
 * The `[tab]` route cannot be rendered here (no DOM harness; it is a client
 * component whose whole body is an effect), so this scans its source — the
 * same idiom `general-tab.rename.test.tsx` uses.
 *
 * What it pins: a segment that is not a live tab but IS a known legacy id must
 * go through `legacySectionRedirect`, not to the default tab. `main` (#6313)
 * graduated `computers` out of settings and into the Connectors page, and this
 * branch carried its own `/settings/computers` href until that merge — so
 * bookmarks of that URL exist and must land where computers actually lives.
 */
describe('the project settings [tab] route resolves legacy segments', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../app/(app)/projects/[id]/settings/[tab]/page.tsx'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('an unparseable segment tries legacySectionRedirect before the bare fallback', () => {
    expect(code).toContain('legacySectionRedirect(projectId, params?.tab)');
    expect(code).toContain('?? `/projects/${projectId}/settings`');
  });

  test('and the resolution it delegates to sends computers to Connectors', () => {
    expect(parseSettingsTab('computers')).toBeNull();
    expect(legacySectionRedirect('p1', 'computers')).toBe('/projects/p1/connectors');
  });

  test('a genuinely unknown segment still has nowhere to go but the default tab', () => {
    expect(legacySectionRedirect('p1', 'nope')).toBeNull();
  });
});
