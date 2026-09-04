import type { ProjectSession, ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { groupSessionsByTrigger } from './trigger-runs-logic';

const trigger = (slug: string) => ({ slug, name: slug }) as ProjectTrigger;
const session = (id: string, trigger_slug: string | null, created_at: string) =>
  ({
    session_id: id,
    created_at,
    metadata: trigger_slug ? { trigger_slug } : {},
  }) as unknown as ProjectSession;

describe('groupSessionsByTrigger', () => {
  test('listed triggers keep listing order and appear even with no runs', () => {
    const groups = groupSessionsByTrigger([], [trigger('b'), trigger('a')]);
    expect(groups.map((g) => g.slug)).toEqual(['b', 'a']);
    expect(groups.every((g) => g.trigger !== null && g.sessions.length === 0)).toBe(true);
  });

  test('runs go under their trigger newest first; chat sessions are not runs', () => {
    const groups = groupSessionsByTrigger(
      [
        session('s1', 'nightly', '2026-09-01T00:00:00.000Z'),
        session('s2', 'nightly', '2026-09-03T00:00:00.000Z'),
        session('chat', null, '2026-09-04T00:00:00.000Z'),
      ],
      [trigger('nightly')],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.session_id)).toEqual(['s2', 's1']);
  });

  test('an unlisted slug becomes an orphan group after the listed ones, by slug', () => {
    const groups = groupSessionsByTrigger(
      [
        session('x', 'zeta', '2026-09-01T00:00:00.000Z'),
        session('y', 'alpha', '2026-09-01T00:00:00.000Z'),
      ],
      [trigger('nightly')],
    );
    expect(groups.map((g) => [g.slug, g.trigger === null])).toEqual([
      ['nightly', false],
      ['alpha', true],
      ['zeta', true],
    ]);
  });
});
