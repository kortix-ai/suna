import type { CraftRun } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { craftReportGroups } from './craft-report-groups';
import {
  agoLabel,
  avgDurationLabel,
  craftRunStatusLabel,
  craftRunStrip,
  durationLabel,
  groupRunsByCraft,
  latestRun,
  runSummary,
  successRateLabel,
} from './craft-runs';
import { craftVisual } from './craft-visual';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function run(over: Partial<CraftRun> = {}): CraftRun {
  return {
    execution_id: 'e1',
    craft_slug: 'seo-watch',
    trigger_slug: 'weekly',
    status: 'done',
    execution_status: 'succeeded',
    scheduled_for: at(10),
    dispatched_at: at(10),
    completed_at: at(8),
    created_at: at(10),
    attempts: 1,
    last_error: null,
    session_id: 's1',
    session_status: 'stopped',
    summary: 'Fixed three broken canonical tags',
    duration_ms: 120_000,
    ...over,
  };
}

describe('agoLabel', () => {
  test('formats each bucket from a real instant', () => {
    expect(agoLabel(at(0), NOW)).toBe('just now');
    expect(agoLabel(at(1), NOW)).toBe('1m ago');
    expect(agoLabel(at(59), NOW)).toBe('59m ago');
    expect(agoLabel(at(90), NOW)).toBe('2h ago');
    expect(agoLabel(at(60 * 30), NOW)).toBe('1d ago');
    expect(agoLabel(at(60 * 24 * 10), NOW)).toBe('1w ago');
    expect(agoLabel(at(60 * 24 * 60), NOW)).toBe('2mo ago');
  });

  test('a null or unparseable timestamp is an em dash, never NaN', () => {
    // The mock could not produce this; a queued run with no dispatch can.
    expect(agoLabel(null, NOW)).toBe('—');
    expect(agoLabel('not a date', NOW)).toBe('—');
  });

  test('a future timestamp clamps to "just now" rather than going negative', () => {
    // Clock skew between the API host and the browser is normal and small.
    // "-2m ago" would be the only wrong answer here.
    expect(agoLabel(new Date(NOW + 120_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('durationLabel', () => {
  test('scales from seconds to hours', () => {
    expect(durationLabel(4_000)).toBe('4s');
    expect(durationLabel(95_000)).toBe('2 min');
    expect(durationLabel(3_600_000)).toBe('1h');
    expect(durationLabel(5_400_000)).toBe('1h 30m');
  });

  test('an open or negative run has no duration', () => {
    expect(durationLabel(null)).toBe('—');
    expect(durationLabel(-1)).toBe('—');
  });
});

describe('stat labels', () => {
  test('a null success rate is an em dash, never 0%', () => {
    // 0% would read as "everything failed" for a craft that has only ever been
    // skipped or is still running.
    expect(successRateLabel(null)).toBe('—');
    expect(successRateLabel(0)).toBe('0%');
    expect(successRateLabel(100)).toBe('100%');
  });

  test('average duration comes in whole seconds and reuses durationLabel', () => {
    expect(avgDurationLabel(null)).toBe('—');
    expect(avgDurationLabel(90)).toBe('2 min');
  });
});

describe('craftRunStrip', () => {
  const runs = [run({ execution_id: 'newest' }), run({ execution_id: 'mid' }), run({ execution_id: 'oldest' })];

  test('takes the newest N and renders them OLDEST-first', () => {
    // The API returns newest-first; a strip reads left-to-right as a timeline,
    // so the newest circle must land beside the age column.
    expect(craftRunStrip(runs, 2).map((r) => r.execution_id)).toEqual(['mid', 'newest']);
  });

  test('a limit above the run count returns every run', () => {
    expect(craftRunStrip(runs, 99)).toHaveLength(3);
  });

  test('an empty list is an empty strip, not a throw', () => {
    expect(craftRunStrip([], 5)).toEqual([]);
    expect(latestRun([])).toBeNull();
  });
});

describe('groupRunsByCraft / craftReportGroups', () => {
  const runs = [
    run({ execution_id: 'a1', craft_slug: 'seo-watch' }),
    run({ execution_id: 'b1', craft_slug: 'error-triage' }),
    run({ execution_id: 'a2', craft_slug: 'seo-watch' }),
  ];

  test('groups preserve the API order, so crafts come back by recency', () => {
    expect([...groupRunsByCraft(runs).keys()]).toEqual(['seo-watch', 'error-triage']);
    expect(groupRunsByCraft(runs).get('seo-watch')?.map((r) => r.execution_id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  test('titles come from the installed manifest entry', () => {
    const groups = craftReportGroups(runs, [
      {
        slug: 'seo-watch',
        repo: 'acme/seo',
        git_ref: null,
        sha: null,
        version: null,
        title: 'SEO watch',
        installed_at: null,
        owns: {},
        enabled: null,
        trigger_count: 0,
        enabled_trigger_count: 0,
      },
    ]);
    expect(groups.map((g) => g.title)).toEqual(['SEO watch', 'error-triage']);
  });

  test('a craft no longer in the manifest keeps its runs, titled by slug', () => {
    // The install lives in the project manifest and outlives its catalogue
    // entry, so a withdrawn craft must not blank the row.
    expect(craftReportGroups(runs, [])[1]).toEqual({
      slug: 'error-triage',
      title: 'error-triage',
      runs: [runs[1]],
    });
  });
});

describe('runSummary', () => {
  test("prefers the session's generated title", () => {
    expect(runSummary(run({ summary: 'Filed 2 issues' }))).toBe('Filed 2 issues');
  });

  test('a failed run says WHY, not just that it failed', () => {
    expect(runSummary(run({ summary: null, status: 'failed', last_error: 'sandbox timeout' }))).toBe(
      'sandbox timeout',
    );
  });

  test('skipped and retrying explain themselves rather than reading as failures', () => {
    expect(runSummary(run({ summary: null, status: 'skipped' }))).toContain('Skipped');
    expect(runSummary(run({ summary: null, status: 'retrying', attempts: 3 }))).toBe(
      'Attempt 3 failed; retrying',
    );
  });

  test('a run that produced no session says so instead of rendering empty', () => {
    expect(runSummary(run({ summary: null, status: 'starting', session_id: null }))).toBe(
      'No session was created for this fire',
    );
  });
});

describe('craftRunStatusLabel', () => {
  test('names all seven states', () => {
    for (const status of [
      'starting',
      'retrying',
      'running',
      'done',
      'failed',
      'stopped',
      'skipped',
    ] as const) {
      expect(craftRunStatusLabel(status)).toMatch(/^[A-Z]/);
    }
  });
});

describe('craftVisual', () => {
  test('is stable for a slug — the same tile on card, modal and report', () => {
    expect(craftVisual('seo-watch')).toEqual(craftVisual('seo-watch'));
  });

  test('is case-insensitive, so a slug cased differently is not a second craft', () => {
    expect(craftVisual('SEO-Watch').Icon).toBe(craftVisual('seo-watch').Icon);
  });

  test('a keyword fixes the glyph without collapsing the hue', () => {
    // Every one of these matches /report/, so they share an icon. The hue must
    // still come from the slug, or a store full of "…-report" crafts would be
    // one colour. Asserting on a PAIR would be wrong: there are five hues, so
    // two arbitrary slugs collide one time in five.
    const slugs = ['weekly-report', 'sales-report', 'ops-report', 'churn-report', 'ads-report'];
    const visuals = slugs.map(craftVisual);
    expect(new Set(visuals.map((v) => v.Icon)).size).toBe(1);
    expect(new Set(visuals.map((v) => v.bgColor)).size).toBeGreaterThan(1);
  });

  test('the hue is paired with its tone — a tile is never blue-on-green', () => {
    for (const slug of ['a', 'seo-watch', 'error-triage', 'invoice-chase', 'standup-scribe']) {
      const { color, bgColor } = craftVisual(slug);
      expect(bgColor).toBe(`${color.replace('text-', 'bg-')}/15`);
    }
  });

  test('every tile is a kortix token, never a raw palette class', () => {
    for (const slug of ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg']) {
      const visual = craftVisual(slug);
      expect(visual.color).toMatch(/^text-kortix-/);
      expect(visual.bgColor).toMatch(/^bg-kortix-.+\/15$/);
    }
  });

  test('an empty slug still returns a tile rather than crashing the card', () => {
    expect(craftVisual('').Icon).toBeDefined();
  });
});
