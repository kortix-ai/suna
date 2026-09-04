import type { ProjectSession, ProjectTrigger } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  RUN_STRIP_LENGTH,
  groupSessionsByTrigger,
  runDisplayStatus,
  runStrip,
  summarizeRuns,
} from './trigger-runs-logic';

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

describe('run status, strip, and totals', () => {
  const run = (id: string, status: string, stage: Record<string, unknown> | null = null) =>
    ({
      session_id: id,
      status,
      stage,
      created_at: `2026-09-0${id.length}T00:00:00.000Z`,
      metadata: { trigger_slug: 'nightly' },
    }) as unknown as ProjectSession;

  test('runDisplayStatus: review items and --needs-approval both read as needs-you', () => {
    expect(runDisplayStatus(run('a', 'running'))).toBe('running');
    expect(runDisplayStatus(run('a', 'running'), { a: 2 })).toBe('needs-you');
    expect(runDisplayStatus(run('a', 'running', { value: 'ready', needs_approval: true }))).toBe(
      'needs-you',
    );
    expect(runDisplayStatus(run('a', 'failed'))).toBe('failed');
    expect(runDisplayStatus(run('a', 'completed'))).toBe('done');
    expect(runDisplayStatus(run('a', 'stopped'))).toBe('stopped');
  });

  test('runStrip: last RUN_STRIP_LENGTH runs, oldest → newest', () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      session(`s${i}`, 'nightly', `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`),
    );
    const [group] = groupSessionsByTrigger(sessions, [trigger('nightly')]);
    const strip = runStrip(group);
    expect(strip).toHaveLength(RUN_STRIP_LENGTH);
    expect(strip[0].session_id).toBe('s3');
    expect(strip[strip.length - 1].session_id).toBe('s14');
  });

  test('summarizeRuns counts triggers, runs, failed, needs-you', () => {
    const groups = groupSessionsByTrigger(
      [run('a', 'failed'), run('bb', 'running'), run('ccc', 'completed')],
      [trigger('nightly'), trigger('idle')],
    );
    expect(summarizeRuns(groups, { bb: 1 })).toEqual({
      triggers: 2,
      runs: 3,
      failed: 1,
      needsYou: 1,
    });
  });
});
