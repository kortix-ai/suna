import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CostModelRow } from '@kortix/sdk';

import { CostModelList } from './cost-model-list';

function model(model: string, cost: number, request_count = 10): CostModelRow {
  return { provider: 'openai', model, cost, request_count };
}

describe('CostModelList', () => {
  test('returns null for an empty list — nothing to answer "which model" with', () => {
    const html = renderToStaticMarkup(<CostModelList models={[]} />);
    expect(html).toBe('');
  });

  test('renders every row when five or fewer, with no "Show all" control', () => {
    const models = [
      model('gpt-5', 10),
      model('claude-opus', 8),
      model('gemini-pro', 4),
    ];
    const html = renderToStaticMarkup(<CostModelList models={models} />);
    expect(html).toContain('gpt-5');
    expect(html).toContain('claude-opus');
    expect(html).toContain('gemini-pro');
    expect(html).not.toContain('Show all');
  });

  test('renders all 5 with no "Show all" control at the exact slice boundary', () => {
    // 5 is the literal number in the brief and VISIBLE_COUNT's own cutoff —
    // rest.length === 0 at exactly 5, so the Disclosure/button must not render.
    const models = [
      model('rank-1', 100),
      model('rank-2', 80),
      model('rank-3', 60),
      model('rank-4', 40),
      model('rank-5', 20),
    ];
    const html = renderToStaticMarkup(<CostModelList models={models} />);
    expect(html).toContain('rank-1');
    expect(html).toContain('rank-5');
    expect(html).not.toContain('Show all');
  });

  test('shows only the top 5 with a "Show all" control when there are more', () => {
    const models = [
      model('rank-1', 100),
      model('rank-2', 80),
      model('rank-3', 60),
      model('rank-4', 40),
      model('rank-5', 20),
      model('rank-6', 10),
      model('rank-7', 5),
    ];
    const html = renderToStaticMarkup(<CostModelList models={models} />);
    expect(html).toContain('rank-1');
    expect(html).toContain('rank-5');
    // The long tail stays collapsed on first paint — asserting its absence is
    // what actually proves the "top 5" cutoff exists, not just that a button
    // renders somewhere.
    expect(html).not.toContain('rank-6');
    expect(html).not.toContain('rank-7');
    expect(html).toContain('Show all');
    expect(html).toContain('7');
  });

  test('sizes the proportional bar behind each row relative to the largest cost', () => {
    const models = [model('big', 100), model('small', 25)];
    const html = renderToStaticMarkup(<CostModelList models={models} />);
    // The top model's bar spans the full row; the smaller one is a quarter.
    expect(html).toContain('width:100%');
    expect(html).toContain('width:25%');
  });

  test('renders cost and request count for each row', () => {
    const models = [model('gpt-5', 12.4, 250)];
    const html = renderToStaticMarkup(<CostModelList models={models} />);
    expect(html).toContain('$12.40');
    expect(html).toContain('250');
  });
});
