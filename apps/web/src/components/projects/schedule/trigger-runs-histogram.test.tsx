import type { ProjectTriggerRun } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RunHistogram } from './trigger-runs-histogram';

const run = (min: number, status: 'fired' | 'failed', cost: number) =>
  ({
    started_at: new Date(Date.UTC(2026, 9, 17, 10, min)).toISOString(),
    status,
    run_status: status === 'fired' ? 'succeeded' : null,
    duration_ms: 38_000,
    cost_usd: cost,
  }) as ProjectTriggerRun;

describe('RunHistogram (C15)', () => {
  test('runs, failed, median duration and credits; 48 bars; one persistent card', () => {
    const out = renderToStaticMarkup(
      <RunHistogram
        runs={[run(0, 'fired', 0.5), run(30, 'failed', 0.02)]}
        live
        onSelectRange={() => {}}
      />,
    );
    expect(out).toContain('runs');
    expect(out).toContain('failed');
    expect(out).toContain('median duration');
    expect(out).toContain('credits');
    expect(out).toContain('Now');
    expect(out.match(/<button/g)?.length).toBe(48);
    // The card is one element, hidden until a bucket is hovered or focused.
    expect(out.match(/aria-hidden="true" style="transform:translateX/g)?.length).toBe(1);
  });

  test('no runs, no histogram', () => {
    expect(renderToStaticMarkup(<RunHistogram runs={[]} live onSelectRange={() => {}} />)).toBe('');
  });
});
