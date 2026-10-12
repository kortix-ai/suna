import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { quickEntryProjectId } from './desktop-quick-entry';

describe('quickEntryProjectId', () => {
  test('the project the window shows wins, on its home and inside a session', () => {
    expect(quickEntryProjectId('/projects/p1', 'p9')).toBe('p1');
    expect(quickEntryProjectId('/projects/p1/sessions/s1', 'p9')).toBe('p1');
  });

  test('off a project, the project this profile opened last', () => {
    expect(quickEntryProjectId('/settings', 'p9')).toBe('p9');
    expect(quickEntryProjectId('/projects', 'p9')).toBe('p9');
    expect(quickEntryProjectId('/projects/start', 'p9')).toBe('p9');
  });

  test('no project known: null, so the prompt goes through the door', () => {
    expect(quickEntryProjectId('/settings', null)).toBeNull();
    expect(quickEntryProjectId(null, null)).toBeNull();
  });
});

describe('DesktopQuickEntry wiring', () => {
  // Rendering needs the router, auth and query client for no extra signal, so
  // the send path is pinned in the source. The composer's submit of a
  // `submit: true` prefill is covered in composer-logic.test.ts.
  const source = readFileSync(fileURLToPath(new URL('./desktop-quick-entry.tsx', import.meta.url)), 'utf8');

  test('a Quick Entry prompt is submitted from project home', () => {
    expect(source).toContain(
      'useComposerPrefillStore.getState().setPrefill(target, prompt.text, { submit: true })',
    );
    expect(source).toContain('router.push(`/projects/${target}`)');
  });

  test('without a project the prompt only fills the composer, through ?q=', () => {
    const start = source.indexOf('if (!target)');
    const fallback = source.slice(start, source.indexOf('return;', start));
    expect(fallback).toContain('/projects/start?q=${encodeURIComponent(prompt.text)}');
    expect(fallback).not.toContain('submit');
  });

  test('takes prompts only for a signed-in user, on mount and on every poke', () => {
    expect(source).toContain('if (!desktop || !userId) return;');
    expect(source).toContain('void take();');
    expect(source).toContain("window.addEventListener('kortix-desktop-quick-entry', take)");
  });
});
