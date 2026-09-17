import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import {
  applyToCachedSessionShape,
  updateCachedProjectSessions,
  upsertCachedProjectSession,
  upsertIntoCachedSessionShape,
} from './session-cache-write';
import type { ProjectSession, SessionPrompt } from '../core/rest/projects-client/sessions';

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

const P = 'project-1';
const T1 = '2026-09-17T10:00:00.000Z';
const T2 = '2026-09-17T10:00:05.000Z';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const at = (id: string, status: string, updatedAt: string | undefined) =>
  ({ session_id: id, custom_name: null, status, updated_at: updatedAt }) as unknown as ProjectSession;

const pagedOf = (items: ProjectSession[]) => ({
  pages: [{ items, next_cursor: null }],
  pageParams: [null],
});

type PagedEntry = ReturnType<typeof pagedOf>;

const prompt = {
  prompt_id: 'c1',
  client_message_id: 'c1',
  message_id: 'msg_c1',
  state: 'queued',
  reason: 'turn_active',
  text: 'second prompt',
  attempts: 0,
  last_error: null,
  created_at: T1,
  available_at: T1,
} satisfies SessionPrompt;

/**
 * Every child entry of `session(id, sid)`, seeded with the shapes that the
 * session-shape writers mistake for a session list or a session row: arrays
 * (prompts, messages) and an object carrying `session_id` (sandbox).
 */
function seedSessionChildren(qc: QueryClient, sessionId: string) {
  const seeded = [
    [qk.project.sessionPrompts(P, sessionId), [prompt]],
    [qk.project.sessionTurn(P, sessionId), { turns: [], atMs: 1_000 }],
    [qk.project.messages(P, sessionId), [{ info: { id: 'msg_1', role: 'user' }, parts: [] }]],
    [qk.project.sessionSandbox(P, sessionId), { session_id: sessionId, external_id: 'sbx_1' }],
  ] as const;
  for (const [key, value] of seeded) qc.setQueryData(key, value);
  return seeded.map(([key, value]) => ({ key, value, copy: structuredClone(value) }));
}

describe('session cache writers reach only session lists and session rows', () => {
  test('upsertCachedProjectSession never writes into a session\'s prompts, turn, messages, or sandbox cache', () => {
    // The prompts cache is an array. Writing a session into it put a
    // ProjectSession in front of the prompt rows, and the next prompts read
    // threw on the row that has no `prompt_id`.
    const qc = client();
    qc.setQueryData(qk.project.sessionsPaged(P), pagedOf([at('s2', 'running', T1)]));
    const children = [...seedSessionChildren(qc, 's2'), ...seedSessionChildren(qc, 's1')];

    upsertCachedProjectSession(qc, P, at('s1', 'provisioning', T1));

    for (const { key, value, copy } of children) {
      expect(qc.getQueryData<unknown>(key)).toBe(value);
      expect(qc.getQueryData<unknown>(key)).toEqual(copy);
    }
    const paged = qc.getQueryData<PagedEntry>(qk.project.sessionsPaged(P));
    expect(paged?.pages[0].items.map((s) => s.session_id)).toEqual(['s1', 's2']);
  });

  test('updateCachedProjectSessions never writes into a session\'s prompts, turn, messages, or sandbox cache', () => {
    const qc = client();
    qc.setQueryData(qk.project.sessions(P), [at('s1', 'running', T1)]);
    const children = seedSessionChildren(qc, 's1');

    // A mapper that changes every row it is handed. A copy-only mapper proves
    // nothing here: react-query's structural sharing keeps the old reference
    // for deep-equal data.
    updateCachedProjectSessions(qc, P, (sessions) =>
      sessions.map((s) => ({ ...s, status: 'stopped' as const })),
    );

    for (const { key, value, copy } of children) {
      expect(qc.getQueryData<unknown>(key)).toBe(value);
      expect(qc.getQueryData<unknown>(key)).toEqual(copy);
    }
  });

  test('updateCachedProjectSessions still updates every list scope, every paged scope, and the row', () => {
    // Guard: the rename modal's optimistic write depends on this reach.
    const qc = client();
    qc.setQueryData(qk.project.sessions(P), [at('s1', 'running', T1)]);
    qc.setQueryData(qk.project.sessions(P, 'project'), [at('s1', 'running', T1)]);
    qc.setQueryData(qk.project.sessionsPaged(P), pagedOf([at('s1', 'running', T1)]));
    qc.setQueryData(qk.project.sessionsPaged(P, 'project'), pagedOf([at('s1', 'running', T1)]));
    qc.setQueryData(qk.project.session(P, 's1'), at('s1', 'running', T1));

    updateCachedProjectSessions(qc, P, rename('s1', 'renamed'));

    for (const scope of ['visible', 'project'] as const) {
      const flat = qc.getQueryData<ProjectSession[]>(qk.project.sessions(P, scope));
      expect(flat?.[0].custom_name).toBe('renamed');
      const paged = qc.getQueryData<PagedEntry>(qk.project.sessionsPaged(P, scope));
      expect(paged?.pages[0].items[0].custom_name).toBe('renamed');
    }
    expect(qc.getQueryData<ProjectSession>(qk.project.session(P, 's1'))?.custom_name).toBe('renamed');
  });

  test('upsertCachedProjectSession still writes every list scope, every paged scope, and the row', () => {
    // Guard: the warm-adoption seed depends on this reach.
    const qc = client();
    qc.setQueryData(qk.project.sessions(P), [at('s2', 'running', T1)]);
    qc.setQueryData(qk.project.sessions(P, 'project'), [at('s2', 'running', T1)]);
    qc.setQueryData(qk.project.sessionsPaged(P), pagedOf([at('s2', 'running', T1)]));
    qc.setQueryData(qk.project.sessionsPaged(P, 'project'), pagedOf([at('s2', 'running', T1)]));
    qc.setQueryData(qk.project.session(P, 's1'), at('s1', 'provisioning', T1));

    upsertCachedProjectSession(qc, P, at('s1', 'running', T2));

    for (const scope of ['visible', 'project'] as const) {
      const flat = qc.getQueryData<ProjectSession[]>(qk.project.sessions(P, scope));
      expect(flat?.map((s) => s.session_id)).toEqual(['s1', 's2']);
      const paged = qc.getQueryData<PagedEntry>(qk.project.sessionsPaged(P, scope));
      expect(paged?.pages[0].items.map((s) => s.session_id)).toEqual(['s1', 's2']);
    }
    expect(qc.getQueryData<ProjectSession>(qk.project.session(P, 's1'))?.status).toBe('running');
  });
});

describe('upsert never replaces a cached session row with an older one', () => {
  test('an older incoming row does not overwrite a newer cached row\'s status', () => {
    // A warm-create row (`provisioning`, stamped at insert) arriving after a
    // read that already shows the session `running` turned the sidebar dot
    // back to starting.
    const qc = client();
    qc.setQueryData(qk.project.sessions(P), [at('s1', 'running', T2)]);
    qc.setQueryData(qk.project.sessionsPaged(P), pagedOf([at('s1', 'running', T2)]));
    qc.setQueryData(qk.project.session(P, 's1'), at('s1', 'running', T2));

    upsertCachedProjectSession(qc, P, at('s1', 'provisioning', T1));

    expect(qc.getQueryData<ProjectSession[]>(qk.project.sessions(P))?.[0].status).toBe('running');
    const paged = qc.getQueryData<PagedEntry>(qk.project.sessionsPaged(P));
    expect(paged?.pages[0].items.map((s) => s.status)).toEqual(['running']);
    expect(qc.getQueryData<ProjectSession>(qk.project.session(P, 's1'))?.status).toBe('running');
  });

  test('a newer incoming row replaces the cached row', () => {
    // Guard.
    const qc = client();
    qc.setQueryData(qk.project.sessions(P), [at('s1', 'provisioning', T1)]);
    qc.setQueryData(qk.project.sessionsPaged(P), pagedOf([at('s1', 'provisioning', T1)]));
    qc.setQueryData(qk.project.session(P, 's1'), at('s1', 'provisioning', T1));

    upsertCachedProjectSession(qc, P, at('s1', 'running', T2));

    expect(qc.getQueryData<ProjectSession[]>(qk.project.sessions(P))?.[0].status).toBe('running');
    const paged = qc.getQueryData<PagedEntry>(qk.project.sessionsPaged(P));
    expect(paged?.pages[0].items.map((s) => s.status)).toEqual(['running']);
    expect(qc.getQueryData<ProjectSession>(qk.project.session(P, 's1'))?.status).toBe('running');
  });

  test('an older row leaves every cached shape untouched, by reference', () => {
    const flat = [at('s1', 'running', T2)];
    expect(upsertIntoCachedSessionShape(flat, at('s1', 'provisioning', T1))).toBe(flat);
    const paged = pagedOf([at('s1', 'running', T2)]);
    expect(upsertIntoCachedSessionShape(paged, at('s1', 'provisioning', T1))).toBe(paged);
    const row = at('s1', 'running', T2);
    expect(upsertIntoCachedSessionShape(row, at('s1', 'provisioning', T1))).toBe(row);
  });

  test('an equal updated_at replaces the cached row', () => {
    // Guard: `>=`, so a re-read of the same server row still lands.
    const incoming = at('s1', 'running', T1);
    expect(upsertIntoCachedSessionShape(at('s1', 'provisioning', T1), incoming)).toBe(incoming);
    const next = upsertIntoCachedSessionShape([at('s1', 'provisioning', T1)], incoming) as ProjectSession[];
    expect(next[0]).toBe(incoming);
  });

  test('without a parseable updated_at on either row, the incoming row replaces the cached one', () => {
    // Guard: the previous behavior, when the rows cannot be ordered.
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, T1],
      [T2, undefined],
      ['not a date', T1],
      [T2, 'not a date'],
    ];
    for (const [cachedAt, incomingAt] of cases) {
      const incoming = at('s1', 'provisioning', incomingAt);
      expect(upsertIntoCachedSessionShape(at('s1', 'running', cachedAt), incoming)).toBe(incoming);
      const flat = upsertIntoCachedSessionShape([at('s1', 'running', cachedAt)], incoming);
      expect((flat as ProjectSession[])[0]).toBe(incoming);
      const paged = upsertIntoCachedSessionShape(pagedOf([at('s1', 'running', cachedAt)]), incoming);
      expect((paged as PagedEntry).pages[0].items[0]).toBe(incoming);
    }
  });

  test('an older row for a session a list does not hold is still inserted', () => {
    // Guard: the ordering rule applies to a replace, never to an insert.
    const next = upsertIntoCachedSessionShape([at('s2', 'running', T2)], at('s1', 'provisioning', T1));
    expect((next as ProjectSession[]).map((s) => s.session_id)).toEqual(['s1', 's2']);
  });
});
