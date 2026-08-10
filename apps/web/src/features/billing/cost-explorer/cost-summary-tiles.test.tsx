import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CostSummaryTiles, formatPeriodDelta, trailingFillerCount } from './cost-summary-tiles';

describe('formatPeriodDelta', () => {
  test('reports a rise against the prior window', () => {
    expect(formatPeriodDelta(46.42, 37.74)).toEqual({ label: '+23%', direction: 'up' });
  });

  test('reports a fall', () => {
    expect(formatPeriodDelta(50, 100)).toEqual({ label: '-50%', direction: 'down' });
  });

  test('returns null when the prior window had no spend', () => {
    expect(formatPeriodDelta(10, 0)).toBeNull();
  });

  test('reports flat when unchanged', () => {
    expect(formatPeriodDelta(10, 10)).toEqual({ label: '0%', direction: 'flat' });
  });

  test('returns null when the prior window was negative (corrupt data guard)', () => {
    expect(formatPeriodDelta(10, -5)).toBeNull();
  });
});

const baseSummary = {
  totals: {
    llm_cost: 12.4,
    compute_cost: 34.02,
    total_cost: 46.42,
    request_count: 100,
    compute_seconds: 3600,
    session_count: 41,
    workspace_count: 3,
  },
  previous: { total_cost: 37.74 },
  // One point per day, as /usage/cost-summary always returns. An empty series
  // was never a shape the route produces, and it silently skipped the
  // sparklines these tiles now render.
  series: [
    { day: '2026-07-01', llm_cost: 1, compute_cost: 6, total_cost: 7 },
    { day: '2026-07-02', llm_cost: 2, compute_cost: 7, total_cost: 9 },
    { day: '2026-07-03', llm_cost: 4, compute_cost: 9, total_cost: 13 },
    { day: '2026-07-04', llm_cost: 5, compute_cost: 12, total_cost: 17 },
  ],
  models: [],
};

describe('CostSummaryTiles', () => {
  test('renders the total and the delta against the prior window', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('$46.42');
    expect(html).toContain('+23%');
  });

  test('renders LLM and compute tiles without a delta of their own', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('$12.40');
    expect(html).toContain('$34.02');
    // Only the total tile shows a period delta. Counting "%" characters would
    // now double-count — the accessible name repeats the figure — so count the
    // delta paragraphs, which is what the assertion always meant.
    expect(html.match(/versus the prior period/g)?.length ?? 0).toBe(1);
  });

  test('never renders the delta as a coloured badge or with green/red text', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).not.toContain('data-slot="badge"');

    // Scoped to the delta paragraph's own class attribute — a global
    // `not.toContain('data-slot="badge"')` alone would still pass if the
    // delta were colour-coded directly (e.g. `text-kortix-red` on the <p>)
    // without ever introducing a Badge. Extract that paragraph's className
    // and assert no direction-coded colour landed on it specifically.
    // The delta reads just "+23%" now — "vs prior period" moved to the
    // accessible name — so match on the aria-label that still carries the
    // comparison, and pull the className off that same paragraph.
    const deltaParagraph = html.match(
      /<p class="([^"]*)" aria-label="\+23% versus the prior period">\+23%<\/p>/,
    );
    expect(deltaParagraph).not.toBeNull();
    expect(deltaParagraph![1]).not.toMatch(/text-kortix-(green|red)/);

    // The sparkline IS colour-coded, deliberately — the guard above is about
    // the number, not the line. Assert the tint landed on the <svg>, so this
    // test cannot start passing because the colour vanished everywhere.
    expect(html).toMatch(/<svg[^>]*text-kortix-(green|red)/);
  });

  test('the trailing row sits on the tile bottom so every sparkline shares one baseline', () => {
    // Grid cells stretch to the tallest in the row, and only the Total tile
    // carries a delta — so a line laid out in flow lands under its own value at
    // a different height per tile. Pinning it into the tile's own bottom-right
    // corner puts all three on one baseline whatever sits above them.
    //
    // Asserted structurally rather than by measurement: the effect is pure CSS
    // and `renderToStaticMarkup` has no layout. `relative` on the tile and
    // `absolute bottom/right` on the line ARE the mechanism, not styling around
    // it — drop either and the corner silently stops being a corner.
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );

    // Read each cell's class attribute rather than splitting on a literal
    // prefix — TILE_CLASS gains and loses utilities, and what is under test is
    // the two classes below, not their position in the string.
    const tileClasses = [...html.matchAll(/<div [^>]*class="([^"]*bg-popover[^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(tileClasses).toHaveLength(3);
    // Each tile is the positioning context for its own line.
    for (const tileClass of tileClasses) {
      expect(tileClass).toContain('relative');
    }
    // One line per tile, each pinned into that tile's bottom-right corner.
    const pinned = [...html.matchAll(/<span class="([^"]*absolute[^"]*)"/g)].map((m) => m[1]);
    expect(pinned).toHaveLength(3);
    for (const wrapperClass of pinned) {
      expect(wrapperClass).toMatch(/\bbottom-/);
      expect(wrapperClass).toMatch(/\bright-/);
    }
  });

  test('suppresses the delta entirely when the prior window had no spend', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[]}
        summary={{ ...baseSummary, previous: { total_cost: 0 } }}
      />,
    );
    expect(html).toContain('$46.42');
    expect(html).not.toContain('%');
  });

  test('renders extra caller-supplied tiles alongside the fixed three', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[
          { label: 'Sessions', value: '41' },
          { label: 'Projects', value: '3' },
        ]}
        summary={baseSummary}
      />,
    );
    expect(html).toContain('Sessions');
    expect(html).toContain('41');
    expect(html).toContain('Projects');
  });

  test('shows a skeleton instead of figures while loading, never a spinner icon', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={true} extraTiles={[]} summary={undefined} />,
    );
    expect(html).not.toContain('$46.42');
    expect(html).not.toContain('animate-spin');
    expect(html).toContain('animate-pulse');
  });

  test('renders a loading skeleton when no summary is available yet, even if isLoading is stale-false', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={undefined} />,
    );
    expect(html).toContain('animate-pulse');
  });
});

// ── The divided-grid geometry ──────────────────────────────────────────────
//
// The hairlines between tiles used to be `divide-x divide-y`, which Tailwind
// compiles to `> * + *` — every child after the first, in DOM order. That
// selector cannot know about rows or columns, so at three columns tiles 2 and
// 3 drew a horizontal rule *inside* row one and tile 4 drew a left border at
// the *start* of row two. The gap-px treatment replaces it.
//
// The gap approach has one failure mode of its own, which is what most of
// these tests are about: an empty grid track shows the container's surface,
// which is border colour, so a tile count that does not fill its rows renders
// a visible block of border where a tile should be.

describe('trailingFillerCount', () => {
  test('a full last row needs no filler', () => {
    expect(trailingFillerCount(3, 3)).toBe(0);
    expect(trailingFillerCount(6, 3)).toBe(0);
    expect(trailingFillerCount(9, 3)).toBe(0);
  });

  test('a short last row is filled up to the column count', () => {
    // 4 tiles at 3 columns: row two holds one tile and two empty tracks.
    expect(trailingFillerCount(4, 3)).toBe(2);
    expect(trailingFillerCount(5, 3)).toBe(1);
    expect(trailingFillerCount(7, 3)).toBe(2);
  });

  test('never negative, and never a whole extra row', () => {
    for (let tileCount = 0; tileCount <= 24; tileCount += 1) {
      for (let columns = 1; columns <= 4; columns += 1) {
        const filler = trailingFillerCount(tileCount, columns);
        expect(filler).toBeGreaterThanOrEqual(0);
        expect(filler).toBeLessThan(columns);
        // The invariant the layout actually depends on: tiles plus filler
        // always fill whole rows, so no track is ever left empty.
        if (tileCount > 0) expect((tileCount + filler) % columns).toBe(0);
      }
    }
  });

  test('degenerate inputs produce no filler rather than an infinite row', () => {
    expect(trailingFillerCount(0, 3)).toBe(0);
    expect(trailingFillerCount(3, 0)).toBe(0);
    expect(trailingFillerCount(3, -1)).toBe(0);
  });
});

describe('CostSummaryTiles grid geometry', () => {
  /** The grid container's own class attribute — the first div in the output. */
  function containerClass(html: string): string {
    const match = html.match(/^<div class="([^"]*)"/);
    expect(match, 'expected the tiles to render a class-carrying container').not.toBeNull();
    return match![1]!;
  }

  test('draws the hairlines with the grid gap, never with divide utilities', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    const container = containerClass(html);
    expect(container).toContain('gap-px');
    expect(container).toContain('bg-border');
    // `divide-x`/`divide-y` are the defect: `> * + *` in DOM order draws
    // borders that do not follow the grid.
    expect(container).not.toContain('divide-x');
    expect(container).not.toContain('divide-y');
  });

  test('uses three columns at every width — a two-column mobile grid would leave the fixed three tiles with an empty track', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    const container = containerClass(html);
    expect(container).toContain('grid-cols-3');
    expect(container).not.toContain('grid-cols-2');
    expect(container).not.toContain('sm:grid-cols');
  });

  // Each cell has to paint an opaque surface over the container, or the
  // container's border colour shows through the tile itself rather than only
  // through the 1px gaps.
  test('every cell paints the card surface over the container', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    const cells = html.match(/<div class="[^"]*px-3 py-2\.5[^"]*"/g) ?? [];
    expect(cells).toHaveLength(3);
    for (const cell of cells) expect(cell).toContain('bg-popover');
  });

  // The constraint the gap-px treatment introduces. `extraTiles` is a public
  // prop; no caller passes one today, so the count is 3 in production — but a
  // component that only lays out correctly at one count is a trap, not a
  // layout. Four tiles at three columns must fill row two rather than leave
  // two blocks of border colour.
  test('fills the last row when extraTiles make the count not divide by three', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[{ label: 'Sessions', value: '41' }]}
        summary={baseSummary}
      />,
    );
    // 4 tiles + 2 fillers = 6 cells, two full rows.
    const cellCount = (html.match(/<div [^>]*class="[^"]*bg-popover[^"]*"/g) ?? []).length;
    expect(cellCount).toBe(6);
    // Fillers carry no content and are hidden from assistive technology.
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBe(2);
  });

  test('adds no filler when extraTiles bring the count back to a multiple of three', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[
          { label: 'Sessions', value: '41' },
          { label: 'Projects', value: '3' },
          { label: 'Requests', value: '100' },
        ]}
        summary={baseSummary}
      />,
    );
    const cellCount = (html.match(/<div [^>]*class="[^"]*bg-popover[^"]*"/g) ?? []).length;
    expect(cellCount).toBe(6);
    expect(html).not.toContain('aria-hidden="true"');
  });

  // The skeleton has to occupy the same cells as the loaded state, or the
  // layout jumps when real figures arrive.
  test('the loading skeleton renders the same cell count and the same filler as the loaded grid', () => {
    const loading = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={true}
        extraTiles={[{ label: 'Sessions', value: '41' }]}
        summary={undefined}
      />,
    );
    expect(containerClass(loading)).toContain('gap-px');
    const cellCount = (loading.match(/<div [^>]*class="[^"]*bg-popover[^"]*"/g) ?? []).length;
    expect(cellCount).toBe(6);
    expect((loading.match(/aria-hidden="true"/g) ?? []).length).toBe(2);
  });
});
