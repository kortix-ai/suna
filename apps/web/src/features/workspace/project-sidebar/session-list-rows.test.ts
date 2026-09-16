import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';

import { buildSidebarSessionRows } from './session-list-rows';
import type { SessionSection } from './session-grouping';

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    session_id: id,
    project_id: 'p1',
    status: 'stopped',
    metadata: {},
    opencode_sessions: [],
    ...extra,
  }) as unknown as ProjectSession;

const section = (id: string, sessions: ProjectSession[]) =>
  ({ id, label: id, sessions }) as unknown as SessionSection;

const shape = (rows: ReturnType<typeof buildSidebarSessionRows>) =>
  rows.map((row) =>
    row.kind === 'header'
      ? `H:${row.section.id}:${row.gap}`
      : row.kind === 'foot'
        ? `F:${row.gap}`
        : `${row.kind === 'session' ? 'S' : 'U'}:${row.kind === 'session' ? row.session.session_id : row.child.id}:${row.nested ? 'n' : '-'}:${row.gap}${row.gapInNested ? ':in' : ''}`,
  );

describe('buildSidebarSessionRows', () => {
  test('headers, rows, and section gaps mirror the old containers', () => {
    const rows = buildSidebarSessionRows({
      sections: [section('today', [session('a'), session('b')]), section('older', [session('c')])],
      showHeaders: true,
      collapsedSectionIds: new Set(),
      activeSessionId: null,
      hasNextPage: false,
    });
    expect(shape(rows)).toEqual(['H:today:1', 'S:a:-:px', 'S:b:-:px', 'H:older:1', 'S:c:-:none']);
  });

  test('a collapsed section is its header only', () => {
    const rows = buildSidebarSessionRows({
      sections: [section('today', [session('a')]), section('older', [session('c')])],
      showHeaders: true,
      collapsedSectionIds: new Set(['today']),
      activeSessionId: null,
      hasNextPage: false,
    });
    expect(shape(rows)).toEqual(['H:today:px', 'H:older:1', 'S:c:-:none']);
  });

  test('no headers when grouping shows one section', () => {
    const rows = buildSidebarSessionRows({
      sections: [section('all', [session('a'), session('b')])],
      showHeaders: false,
      collapsedSectionIds: new Set(),
      activeSessionId: null,
      hasNextPage: true,
    });
    expect(shape(rows)).toEqual(['S:a:-:px', 'S:b:-:px', 'F:none']);
  });

  test('spawned sessions nest under their coordinator with space-y-1 inside the border', () => {
    const rows = buildSidebarSessionRows({
      sections: [
        section('all', [
          session('coord'),
          session('kid1', { metadata: { spawned_by_session: 'coord' } }),
          session('kid2', { metadata: { spawned_by_session: 'coord' } }),
          session('solo'),
        ]),
      ],
      showHeaders: false,
      collapsedSectionIds: new Set(),
      activeSessionId: null,
      hasNextPage: false,
    });
    expect(shape(rows)).toEqual([
      'S:coord:-:px',
      'S:kid1:n:1:in',
      'S:kid2:n:px',
      'S:solo:-:none',
    ]);
  });

  test('the open session lists its sub-sessions with no gap between them', () => {
    const open = session('open', {
      opencode_sessions: [
        { id: 'root', parent_id: null },
        { id: 'child1', parent_id: 'root' },
        { id: 'child2', parent_id: 'root' },
      ],
      opencode_session_id: 'root',
    });
    const rows = buildSidebarSessionRows({
      sections: [section('all', [open, session('next')])],
      showHeaders: false,
      collapsedSectionIds: new Set(),
      activeSessionId: 'open',
      hasNextPage: false,
    });
    const subs = rows.filter((row) => row.kind === 'subsession');
    // Whatever `directSubsessions` returns for this snapshot is listed in order.
    expect(rows[0]).toMatchObject({ kind: 'session', gap: subs.length ? 'px' : 'px' });
    if (subs.length > 0) {
      expect(subs.slice(0, -1).every((row) => row.gap === 'none')).toBe(true);
      expect(subs.at(-1)!.gap).toBe('px');
    }
    expect(rows.at(-1)).toMatchObject({ kind: 'session', gap: 'none' });
  });

  test('12,000 sessions build in well under a frame budget', () => {
    const sessions = Array.from({ length: 12_000 }, (_, i) => session(`s${i}`));
    const started = performance.now();
    const rows = buildSidebarSessionRows({
      sections: [section('older', sessions)],
      showHeaders: true,
      collapsedSectionIds: new Set(),
      activeSessionId: null,
      hasNextPage: true,
    });
    expect(rows).toHaveLength(12_002);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
