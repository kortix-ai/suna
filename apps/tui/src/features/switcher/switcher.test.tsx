import { describe, expect, test } from 'bun:test';

import { resolveSwitcherItem, switcherItems } from './switcher.tsx';

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

function session(id: string, name: string, minutesAgo: number, status = 'running') {
  return {
    session_id: id,
    name,
    status,
    updated_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  };
}

describe('switcherItems', () => {
  const items = switcherItems({
    sessions: [session('s1', 'Casual greeting', 3), session('s2', 'Fix claims', 90, 'stopped')],
    projects: [
      { project_id: 'p1', name: 'Project Atlas' },
      { project_id: 'p2', name: 'Essentia' },
    ],
    activeProjectId: 'p1',
    now: NOW,
  });

  test('sessions come first, then projects', () => {
    expect(items.map((item) => item.id)).toEqual([
      'session:s1',
      'session:s2',
      'project:p1',
      'project:p2',
    ]);
  });

  test('a session row carries its name, status glyph and age', () => {
    expect(items[0]).toMatchObject({ label: 'Casual greeting', glyph: '●', right: '3m' });
    expect(items[1]).toMatchObject({ label: 'Fix claims', glyph: '○', right: '1h' });
  });

  test('the active project is marked, never hidden', () => {
    expect(items[2]).toMatchObject({ label: 'project · Project Atlas', right: 'active' });
    expect(items[3]).toMatchObject({ label: 'project · Essentia', right: '' });
  });

  test('an unnamed session still gets a row', () => {
    const [row] = switcherItems({
      sessions: [{ session_id: 's9', name: null, status: 'stopped', updated_at: undefined }],
      projects: [],
      activeProjectId: null,
      now: NOW,
    });
    expect(row?.label).toBe('Untitled');
  });
});

describe('resolveSwitcherItem', () => {
  test('decodes both prefixes', () => {
    expect(resolveSwitcherItem('session:abc')).toEqual({ kind: 'session', sessionId: 'abc' });
    expect(resolveSwitcherItem('project:abc')).toEqual({ kind: 'project', projectId: 'abc' });
  });

  test('an unknown id resolves to null rather than guessing', () => {
    expect(resolveSwitcherItem('abc')).toBeNull();
    expect(resolveSwitcherItem('')).toBeNull();
  });

  test('a uuid with a colon in the name round-trips', () => {
    const id = '55823831-60a3-4c46-b345-3079a78d0296';
    expect(resolveSwitcherItem(`session:${id}`)).toEqual({ kind: 'session', sessionId: id });
  });
});
