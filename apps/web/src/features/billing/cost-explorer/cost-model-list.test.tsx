import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CostModelRow } from '@kortix/sdk';

import { CostModelList, modelListToggleLabel } from './cost-model-list';

function model(model: string, cost: number, request_count = 10): CostModelRow {
  return { provider: 'openai', model, cost, request_count };
}

describe('CostModelList', () => {
  test('returns null for an empty list — nothing to answer "which model" with', () => {
    const html = renderToStaticMarkup(<CostModelList models={[]} />);
    expect(html).toBe('');
  });

  test('renders every row when five or fewer, with no expand control', () => {
    const models = [
      model('gpt-5', 10),
      model('claude-opus', 8),
      model('gemini-pro', 4),
    ];
    const html = renderToStaticMarkup(<CostModelList models={models} />);
    expect(html).toContain('gpt-5');
    expect(html).toContain('claude-opus');
    expect(html).toContain('gemini-pro');
    expect(html).not.toContain('Show');
  });

  test('renders all 5 with no expand control at the exact slice boundary', () => {
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
    expect(html).not.toContain('Show');
  });

  test('shows only the top 5 with an expand control when there are more', () => {
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
    // 7 models, 5 shown: the label names the click's outcome (2 more), never
    // the list's size (7) — which under five visible rows reads as "7 more".
    expect(html).toContain('Show 2 more');
    expect(html).not.toContain('Show all');
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

// ── The expand toggle ──────────────────────────────────────────────────────
//
// Two separate defects, one control. The label named the wrong quantity, and
// the control did not look like a control.

describe('modelListToggleLabel', () => {
  // The number is the remainder, never the total. Under five visible rows a
  // total reads as a remainder — that ambiguity is the whole defect — so the
  // label is written from the hidden count and nothing else.
  test('names how many rows the click reveals, not how many exist', () => {
    expect(modelListToggleLabel(7, false)).toBe('Show 7 more');
    expect(modelListToggleLabel(1, false)).toBe('Show 1 more');
  });

  test('names the reverse action once expanded', () => {
    expect(modelListToggleLabel(7, true)).toBe('Show less');
  });

  // The label must not quietly restate the list size. `CostModelList` renders
  // 5 rows before the toggle, so a label built from `models.length` and a
  // label built from `rest.length` differ by exactly 5 — the shape of the
  // original bug.
  test('a 12-model list under 5 visible rows reads "Show 7 more", never "Show all (12)"', () => {
    expect(modelListToggleLabel(12 - 5, false)).toBe('Show 7 more');
  });
});

describe('CostModelList expand control', () => {
  const twelveModels = Array.from({ length: 12 }, (_, index) =>
    model(`rank-${index + 1}`, 100 - index),
  );

  /** The toggle button's own markup, so control assertions cannot pass by
   *  matching a model row instead. */
  function toggleButton(html: string): string {
    const match = html.match(/<button[^>]*>(?:(?!<\/button>).)*Show[^<]*(?:(?!<\/button>).)*<\/button>/);
    expect(match, 'expected an expand toggle in the rendered output').not.toBeNull();
    return match![0];
  }

  test('reads "Show 7 more" for a 12-model list', () => {
    const html = renderToStaticMarkup(<CostModelList models={twelveModels} />);
    expect(html).toContain('Show 7 more');
  });

  // Affordance, not copy. The toggle used to be a transparent ghost button
  // with `rounded-none` in a `divide-y` card, i.e. the same width, seam and
  // surface as the five model rows above it — so it read as a sixth row of
  // data. A tinted surface is what separates a control from the data.
  test('carries a surface distinction the model rows do not', () => {
    const html = renderToStaticMarkup(<CostModelList models={twelveModels} />);
    const button = toggleButton(html);
    expect(button).toContain('bg-popover-foreground/5');

    // The data rows must NOT pick up that surface, or the distinction says
    // nothing. Each model row is the `<p>`-bearing block; check the row
    // containing rank-1 specifically.
    const rowMatch = html.match(/<div class="relative">(?:(?!<\/p>).)*rank-1/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch![0]).not.toContain('bg-popover-foreground/5');
  });

  test('stays full width — the whole card footer is the hit area', () => {
    const button = toggleButton(renderToStaticMarkup(<CostModelList models={twelveModels} />));
    expect(button).toContain('w-full');
  });

  /** The chevron's own class attribute. Scoped to the `<svg>` because the
   *  shared `Button` primitive puts `transition-all` on the BUTTON element
   *  (`buttonVariants`' base, app-wide and out of scope here) — and CSS
   *  `transition` does not inherit, so the chevron's rotation is governed by
   *  the svg's own declaration, which is the one under test. */
  function chevronClass(html: string): string {
    const match = toggleButton(html).match(/<svg[^>]*class="([^"]*)"/);
    expect(match, 'expected a chevron inside the toggle').not.toBeNull();
    return match![1]!;
  }

  // Direction indicator. Collapsed is the only state a static render reaches
  // (`useState(false)`, and renderToStaticMarkup cannot fire the click), so
  // this pins the resting state: a chevron is present and is NOT rotated.
  test('renders a chevron that is unrotated while collapsed', () => {
    const html = renderToStaticMarkup(<CostModelList models={twelveModels} />);
    expect(toggleButton(html)).toContain('<svg');
    expect(chevronClass(html)).not.toContain('rotate-180');
  });

  // Never `transition: all` on the rotation. The button also changes
  // background and text colour on hover; animating those through the same
  // declaration would tie an unrelated 200ms to the hover.
  test('animates transform only, at ~200ms ease-out', () => {
    const chevron = chevronClass(renderToStaticMarkup(<CostModelList models={twelveModels} />));
    expect(chevron).toContain('transition-transform');
    expect(chevron).toContain('duration-200');
    expect(chevron).toContain('ease-out');
    expect(chevron).not.toMatch(/\btransition-all\b/);
  });

  // The chevron is decoration over a label that already says what the click
  // does, so it must not be announced.
  test('the chevron is hidden from assistive technology', () => {
    const button = toggleButton(renderToStaticMarkup(<CostModelList models={twelveModels} />));
    expect(button).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});
