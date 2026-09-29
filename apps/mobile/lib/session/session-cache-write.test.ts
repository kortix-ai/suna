import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk, updateCachedProjectSessions } from '@kortix/sdk/react/session-list';

import type { ProjectSession } from '@/lib/projects/projects-client';

import {
  cachedSessionRow,
  createdSessionListRow,
  listCreatedSession,
  mergeRenamed,
  removeListedSession,
  renameInRows,
} from './session-cache-write';

/**
 * A rename, a delete and a new session used to reach the drawer and the
 * Sessions page only after the refetch that follows the server's answer.
 * These tests pin the writes that show them at once.
 */

const row = (session_id: string, extra: Partial<ProjectSession> = {}) =>
  ({ session_id, name: null, custom_name: null, ...extra }) as ProjectSession;

const paged = (...pages: ProjectSession[][]) => ({
  pages: pages.map((items, i) => ({
    items,
    next_cursor: i < pages.length - 1 ? `c${i + 1}` : null,
  })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i}`)),
});

type Paged = ReturnType<typeof paged>;
const ids = (cache: unknown) =>
  (cache as Paged).pages.map((page) => page.items.map((session) => session.session_id));

describe('rename', () => {
  test('a name sets custom_name and the display name, as the server answers', () => {
    const rows = [row('a'), row('b', { name: 'Auto title' })];
    const next = renameInRows(rows, 'b', 'Release notes');
    expect(next[1]).toMatchObject({ custom_name: 'Release notes', name: 'Release notes' });
    expect(next[0]).toBe(rows[0]);
  });

  test('an empty name clears the rename and leaves the display name to the server', () => {
    const rows = [row('a', { custom_name: 'Mine', name: 'Mine' })];
    expect(renameInRows(rows, 'a', '')[0]).toMatchObject({ custom_name: null, name: 'Mine' });
  });

  test('an unknown session or an unchanged name: the rows by reference', () => {
    const rows = [row('a', { custom_name: 'Mine', name: 'Mine' })];
    expect(renameInRows(rows, 'zzz', 'x')).toBe(rows);
    expect(renameInRows(rows, 'a', 'Mine')).toBe(rows);
  });

  test('the server’s answer merges name, custom_name and updated_at only', () => {
    const rows = [row('a', { owner_email: 'kept-owner', runtime_status: 'active' })];
    const answer = row('a', {
      name: 'Server name',
      custom_name: 'Server name',
      updated_at: '2026-09-26T12:00:00Z',
      owner_email: null,
      runtime_status: null,
    });
    expect(mergeRenamed(rows, answer)[0]).toMatchObject({
      name: 'Server name',
      custom_name: 'Server name',
      updated_at: '2026-09-26T12:00:00Z',
      owner_email: 'kept-owner',
      runtime_status: 'active',
    });
    expect(mergeRenamed(rows, row('zzz'))).toBe(rows);
  });
});

describe('createdSessionListRow', () => {
  const created = {
    session_id: 's-new',
    project_id: 'p-1',
    status: 'queued',
    created_at: '2026-09-26T12:00:00Z',
    updated_at: '2026-09-26T12:00:00Z',
    opencode_sessions: [],
    metadata: { name: 'Title', initial_prompt: 'the prompt text', session_start_timeline: {} },
  };

  test('a 201 row becomes a list row, without the metadata the list leaves out', () => {
    const listed = createdSessionListRow(created, 'p-1');
    expect(listed?.session_id).toBe('s-new');
    expect(listed?.metadata).toEqual({ name: 'Title' });
  });

  test('a row without list-omitted metadata is kept by reference', () => {
    const plain = { ...created, metadata: { name: 'Title' } };
    expect(createdSessionListRow(plain, 'p-1')).toBe(plain as unknown as ProjectSession);
  });

  test('a 202 "create queued" answer is not a row', () => {
    const accepted = { status: 'queued', command_id: 'cmd-1', session_id: 's-new', reason: null };
    expect(createdSessionListRow(accepted, 'p-1')).toBeNull();
  });

  test('another project’s row, or no object at all, is not listed here', () => {
    expect(createdSessionListRow(created, 'p-2')).toBeNull();
    expect(createdSessionListRow(undefined, 'p-1')).toBeNull();
    expect(createdSessionListRow('s-new', 'p-1')).toBeNull();
  });
});

/**
 * The writes as the screens run them, over a real QueryClient holding every
 * list shape the app caches under the SDK's keys: the flat first page, the
 * drawer's "Sessions" / "Shared" / "Automated" sections, the Sessions page's
 * All scope and a search, and one parent's children.
 */
describe('session list writes over the real query client', () => {
  const P = 'p-1';
  const FLAT = qk.project.sessions(P);
  const MINE = qk.project.sessionsPaged(P, 'visible', { parent: 'root', startedBy: 'me' });
  const SHARED = qk.project.sessionsPaged(P, 'visible', { parent: 'root', startedBy: 'others' });
  const AUTOMATED = qk.project.sessionsPaged(P, 'visible', { parent: 'root', startedBy: 'automated' });
  const ALL = qk.project.sessionsPaged(P, 'visible', { parent: 'root' });
  const SEARCH = qk.project.sessionsPaged(P, 'visible', { parent: 'root', q: 'deploy' });
  const CHILDREN = qk.project.sessionChildren(P, 'a');

  const mine = row('a', { is_owner: true, child_count: 1 });
  const theirs = row('t', { is_owner: false, initiator: { type: 'member', id: 'u2', label: 'Ada' } });
  const child = row('c', { parent_session_id: 'a' } as Partial<ProjectSession>);

  function seed() {
    const client = new QueryClient();
    client.setQueryData(FLAT, [mine, theirs]);
    client.setQueryData(MINE, paged([mine]));
    client.setQueryData(SHARED, paged([theirs]));
    client.setQueryData(AUTOMATED, paged([]));
    client.setQueryData(ALL, paged([mine, theirs]));
    client.setQueryData(SEARCH, paged([mine]));
    client.setQueryData(CHILDREN, paged([child]));
    return client;
  }

  test('create: the new row tops the viewer\'s lists and the flat page, never Shared, Automated, a search or children', () => {
    const client = seed();
    const created = {
      session_id: 'new',
      project_id: P,
      status: 'queued',
      created_at: '2026-09-29T00:00:00Z',
      is_owner: true,
      metadata: { initial_prompt: 'kept out of the list' },
    };
    listCreatedSession(client, P, created);

    expect((client.getQueryData(FLAT) as ProjectSession[]).map((s) => s.session_id)).toEqual(['new', 'a', 't']);
    expect(ids(client.getQueryData(MINE))).toEqual([['new', 'a']]);
    expect(ids(client.getQueryData(ALL))).toEqual([['new', 'a', 't']]);
    expect(ids(client.getQueryData(SHARED))).toEqual([['t']]);
    expect(ids(client.getQueryData(AUTOMATED))).toEqual([[]]);
    expect(ids(client.getQueryData(SEARCH))).toEqual([['a']]);
    expect(ids(client.getQueryData(CHILDREN))).toEqual([['c']]);
    expect((client.getQueryData(MINE) as Paged).pages[0].items[0].metadata).toEqual({});
    client.clear();
  });

  test('create: a 202 "create queued" answer writes nothing', () => {
    const client = seed();
    const before = client.getQueryData(MINE);
    listCreatedSession(client, P, { status: 'queued', command_id: 'cmd', session_id: 'new', reason: null });
    expect(client.getQueryData(MINE) as unknown).toBe(before);
    client.clear();
  });

  test('rename: every list that holds the row shows the new name; the rest keep their identity', () => {
    const client = seed();
    const shared = client.getQueryData(SHARED);
    updateCachedProjectSessions(client, P, (rows) => renameInRows(rows, 'a', 'Release notes'));

    for (const key of [MINE, ALL, SEARCH]) {
      expect((client.getQueryData(key) as Paged).pages[0].items[0].custom_name).toBe('Release notes');
    }
    expect((client.getQueryData(FLAT) as ProjectSession[])[0].name).toBe('Release notes');
    expect(client.getQueryData(SHARED) as unknown).toBe(shared);

    // The undo SessionRenameForm runs when the server refuses: the old name fields back.
    updateCachedProjectSessions(client, P, (rows) => mergeRenamed(rows, mine));
    expect((client.getQueryData(MINE) as Paged).pages[0].items[0].custom_name).toBeNull();
    client.clear();
  });

  test('rename: a child row renames inside its parent\'s children list', () => {
    const client = seed();
    updateCachedProjectSessions(client, P, (rows) => renameInRows(rows, 'c', 'Worker'));
    expect((client.getQueryData(CHILDREN) as Paged).pages[0].items[0].name).toBe('Worker');
    client.clear();
  });

  test('delete: the row leaves every paged list and children, the flat page keeps it, and the undo restores all', () => {
    const client = seed();
    const before = client.getQueryData(MINE);
    const undo = removeListedSession(client, P, 'a');

    expect(ids(client.getQueryData(MINE))).toEqual([[]]);
    expect(ids(client.getQueryData(ALL))).toEqual([['t']]);
    expect(ids(client.getQueryData(SEARCH))).toEqual([[]]);
    expect((client.getQueryData(FLAT) as ProjectSession[]).map((s) => s.session_id)).toEqual(['a', 't']);

    const childUndo = removeListedSession(client, P, 'c');
    expect(ids(client.getQueryData(CHILDREN))).toEqual([[]]);
    childUndo();
    expect(ids(client.getQueryData(CHILDREN))).toEqual([['c']]);

    undo();
    expect(client.getQueryData(MINE) as unknown).toEqual(before);
    client.clear();
  });

  test('cachedSessionRow finds the freshest row in any list shape, else null', () => {
    const client = seed();
    expect(cachedSessionRow(client, P, 'c')).toBe(child);
    expect(cachedSessionRow(client, P, 't')?.session_id).toBe('t');
    expect(cachedSessionRow(client, P, 'zzz')).toBeNull();
    expect(cachedSessionRow(client, 'p-other', 'a')).toBeNull();
    client.clear();
  });
});
