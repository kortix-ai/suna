import { describe, expect, test } from 'bun:test';
import { applyToCachedSessionShape, upsertIntoCachedSessionShape } from './session-cache-write';
import type { ProjectSession } from '../core/rest/projects-client/sessions';

const rename =
  (id: string, name: string) =>
  (sessions: ProjectSession[]): ProjectSession[] =>
    sessions.map((s) => (s.session_id === id ? { ...s, custom_name: name } : s));

const row = (id: string) => ({ session_id: id, custom_name: null }) as unknown as ProjectSession;

describe('applyToCachedSessionShape', () => {
  test('updates a flat session list', () => {
    const cached = [row('S1'), row('S2')];
    const next = applyToCachedSessionShape(cached, rename('S2', 'renamed')) as ProjectSession[];
    expect(next.map((s) => s.custom_name)).toEqual([null, 'renamed']);
  });

  test('updates every page of an infinite-query cache', () => {
    // The sidebar caches `{ pages, pageParams }`, not an array. A writer that
    // only knew the flat shape left the sidebar showing the OLD name until the
    // post-mutation refetch landed.
    const cached = {
      pages: [
        { items: [row('S1')], next_cursor: 'C1' },
        { items: [row('S2')], next_cursor: null },
      ],
      pageParams: [null, 'C1'],
    };
    const next = applyToCachedSessionShape(cached, rename('S2', 'renamed')) as typeof cached;
    expect(next.pages[0].items[0].custom_name).toBeNull();
    expect(next.pages[1].items[0].custom_name).toBe('renamed');
    expect(next.pageParams).toEqual([null, 'C1']);
  });

  test('updates a single cached session row', () => {
    const next = applyToCachedSessionShape(row('S1'), rename('S1', 'renamed')) as ProjectSession;
    expect(next.custom_name).toBe('renamed');
  });

  test('a single cached row is matched by id, not by position', () => {
    // An updater that PREPENDS (a new session being seeded) must not turn the
    // `session(projectId, sessionId)` entry into some other session's row.
    // Taking element 0 did exactly that.
    const prepend = (sessions: ProjectSession[]) => [row('NEW'), ...sessions];
    const next = applyToCachedSessionShape(row('S1'), prepend) as ProjectSession;
    expect(next.session_id).toBe('S1');
  });

  test('leaves an unrecognized shape untouched, by reference', () => {
    // Everything under the sessions prefix is passed through here, including
    // entries this helper knows nothing about. Returning a NEW value for one
    // would make react-query re-render every observer of it for no reason.
    const other = { total: 3 };
    expect(applyToCachedSessionShape(other, rename('S1', 'x'))).toBe(other);
    expect(applyToCachedSessionShape(undefined, rename('S1', 'x'))).toBeUndefined();
  });
});

describe('upsertIntoCachedSessionShape', () => {
  test('prepends to the FIRST page only', () => {
    // Prepending to every page would show the new session once per loaded
    // page. The list is ordered by most recent activity, so the top of page one
    // is the only place a just-created session belongs.
    const cached = {
      pages: [
        { items: [row('S1')], next_cursor: 'C1' },
        { items: [row('S2')], next_cursor: null },
      ],
      pageParams: [null, 'C1'],
    };
    const next = upsertIntoCachedSessionShape(cached, row('NEW')) as typeof cached;
    expect(next.pages[0].items.map((s) => s.session_id)).toEqual(['NEW', 'S1']);
    expect(next.pages[1].items.map((s) => s.session_id)).toEqual(['S2']);
  });

  test('replaces in place when the session is already cached', () => {
    const existing = { session_id: 'S2', custom_name: 'old' } as unknown as ProjectSession;
    const cached = {
      pages: [
        { items: [row('S1')], next_cursor: 'C1' },
        { items: [existing], next_cursor: null },
      ],
      pageParams: [null, 'C1'],
    };
    const updated = { session_id: 'S2', custom_name: 'new' } as unknown as ProjectSession;
    const next = upsertIntoCachedSessionShape(cached, updated) as typeof cached;
    expect(next.pages[0].items.map((s) => s.session_id)).toEqual(['S1']);
    expect(next.pages[1].items[0].custom_name).toBe('new');
  });

  test('prepends to a flat list', () => {
    const next = upsertIntoCachedSessionShape([row('S1')], row('NEW')) as ProjectSession[];
    expect(next.map((s) => s.session_id)).toEqual(['NEW', 'S1']);
  });

  test('leaves an unrecognized shape and a foreign single row untouched', () => {
    const other = { total: 3 };
    expect(upsertIntoCachedSessionShape(other, row('NEW'))).toBe(other);
    const foreign = row('S1');
    expect(upsertIntoCachedSessionShape(foreign, row('NEW'))).toBe(foreign);
  });

  test('replaces the single-row entry when it IS that session', () => {
    const updated = { session_id: 'S1', custom_name: 'x' } as unknown as ProjectSession;
    expect(upsertIntoCachedSessionShape(row('S1'), updated)).toBe(updated);
  });
});
