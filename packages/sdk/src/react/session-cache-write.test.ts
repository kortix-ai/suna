import { describe, expect, test } from 'bun:test';
import { applyToCachedSessionShape } from './session-cache-write';
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

  test('leaves an unrecognized shape untouched, by reference', () => {
    // Everything under the sessions prefix is passed through here, including
    // entries this helper knows nothing about. Returning a NEW value for one
    // would make react-query re-render every observer of it for no reason.
    const other = { total: 3 };
    expect(applyToCachedSessionShape(other, rename('S1', 'x'))).toBe(other);
    expect(applyToCachedSessionShape(undefined, rename('S1', 'x'))).toBeUndefined();
  });
});
