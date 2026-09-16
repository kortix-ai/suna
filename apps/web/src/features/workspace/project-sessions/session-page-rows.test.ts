import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import type { SessionSection } from '@/features/workspace/project-sidebar/session-grouping';

import { buildSessionsPageRows } from './session-page-rows';

const session = (id: string) => ({ session_id: id }) as unknown as ProjectSession;
const section = (id: string, ids: string[]) =>
  ({ id, label: id, sessions: ids.map(session) }) as unknown as SessionSection;
const shape = (rows: ReturnType<typeof buildSessionsPageRows>) =>
  rows.map((row) =>
    row.kind === 'header'
      ? `H:${row.section.id}:${row.gap}`
      : row.kind === 'session'
        ? `S:${row.session.session_id}:${row.gap}`
        : `F:${row.gap}`,
  );

describe('buildSessionsPageRows', () => {
  test('space-y-2 inside a section, space-y-4 between sections', () => {
    const rows = buildSessionsPageRows({
      sections: [section('today', ['a', 'b']), section('older', ['c'])],
      showHeaders: true,
      collapsedSectionIds: new Set(),
      hasNextPage: false,
    });
    expect(shape(rows)).toEqual(['H:today:2', 'S:a:2', 'S:b:4', 'H:older:2', 'S:c:none']);
  });

  test('a collapsed section keeps its header and the section gap', () => {
    const rows = buildSessionsPageRows({
      sections: [section('today', ['a']), section('older', ['c'])],
      showHeaders: true,
      collapsedSectionIds: new Set(['today']),
      hasNextPage: true,
    });
    expect(shape(rows)).toEqual(['H:today:4', 'H:older:2', 'S:c:4', 'F:none']);
  });

  test('without headers a section is its rows; filters that match nothing leave only the foot', () => {
    expect(
      shape(
        buildSessionsPageRows({
          sections: [section('all', ['a', 'b'])],
          showHeaders: false,
          collapsedSectionIds: new Set(['all']),
          hasNextPage: false,
        }),
      ),
    ).toEqual(['S:a:2', 'S:b:none']);
    expect(
      shape(
        buildSessionsPageRows({ sections: [], showHeaders: false, collapsedSectionIds: new Set(), hasNextPage: true }),
      ),
    ).toEqual(['F:none']);
  });
});
