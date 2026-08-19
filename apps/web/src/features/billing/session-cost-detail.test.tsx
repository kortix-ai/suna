import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionCostDetail } from '@kortix/sdk';

import { SessionCostDetailContent } from './session-cost-detail';

const detail = {
  session_id: 'session-detail',
  project_id: 'project-detail',
  project_name: 'Research workflows',
  owner_id: 'owner-1',
  owner_type: 'user',
  owner_name: 'Session owner',
  owner_email: 'owner@example.test',
  status: 'running',
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T11:00:00.000Z',
  last_activity_at: '2026-07-01T11:00:00.000Z',
  llm_cost: 1.25,
  llm_kortix_cost: 0,
  llm_provider_cost: 1.25,
  compute_cost: 0.5,
  total_cost: 1.75,
  request_count: 2,
  error_count: 0,
  input_tokens: 100,
  output_tokens: 50,
  cached_tokens: 10,
  cache_write_tokens: 5,
  model_count: 1,
  compute_seconds: 120,
  model_usage: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet',
      request_count: 2,
      error_count: 0,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
      cost: 1.25,
      last_at: '2026-07-01T11:00:00.000Z',
    },
  ],
  ledger_entries: [
    {
      kind: 'llm',
      id: 'llm-entry',
      occurred_at: '2026-07-01T11:00:00.000Z',
      cost: 1.25,
      provider: 'anthropic',
      model: 'claude-sonnet',
      request_id: 'request-1',
      status: 200,
      ok: true,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
    },
    {
      kind: 'compute',
      id: 'compute-entry',
      started_at: '2026-07-01T10:00:00.000Z',
      ended_at: '2026-07-01T10:02:00.000Z',
      billed_through_at: '2026-07-01T10:02:00.000Z',
      cost: 0.5,
      provider: 'daytona',
      state: 'stopped',
      compute_seconds: 120,
      cpu_cores: 2,
      memory_gb: 4,
      disk_gb: 20,
      gpu_count: 0,
    },
  ],
} satisfies SessionCostDetail;

describe('SessionCostDetailContent', () => {
  test('renders totals, model usage, both ledger kinds, and the canonical session link', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent detail={detail} isLoading={false} error={null} />,
    );

    expect(html).toContain('Session cost details');
    expect(html).toContain('$1.75');
    expect(html).toContain('claude-sonnet');
    expect(html).toContain('request-1');
    expect(html).toContain('2m');
    expect(html).toContain('2 vCPU');
    expect(html).toContain('href="/projects/project-detail/sessions/session-detail"');
  });

  test('renders loading and error states without stale detail', () => {
    const loading = renderToStaticMarkup(
      <SessionCostDetailContent detail={undefined} isLoading error={null} />,
    );
    const failed = renderToStaticMarkup(
      <SessionCostDetailContent
        detail={undefined}
        isLoading={false}
        error={new Error('detail failed')}
      />,
    );

    expect(loading).toContain('Loading session cost details');
    expect(failed).toContain('Failed to load session cost details');
    expect(failed).toContain('detail failed');
  });

  // Level 3 of the cost explorer, checked against the same defect that made
  // Levels 1 and 2 present a failed fetch as an empty one (see
  // sessions-level.test.tsx). This component was already correct — its
  // skeleton is gated on `isLoading || !detail`, not `isLoading && !detail`
  // — so a detail that was never read renders as loading, never as "no cost
  // entries". Pinned here so the safe form cannot be "tidied" into the
  // broken one: React Query reports `isLoading: false` with a null error and
  // no data in every pending-but-not-fetching state (query disabled, fetch
  // cancelled, retry loop paused while the document is hidden or offline).
  test('a ledger that was never read renders as loading, never as an empty ledger', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent detail={undefined} isLoading={false} error={null} />,
    );

    expect(html).toContain('Loading session cost details');
    expect(html).not.toContain('No cost entries');
  });

  test('renders an explicit empty ledger', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent
        detail={{ ...detail, model_usage: [], ledger_entries: [] }}
        isLoading={false}
        error={null}
      />,
    );

    expect(html).toContain('No cost entries');
    expect(html).toContain('This session has no finalized LLM or compute entries.');
  });

  // ── The six-tile grid's hairlines ────────────────────────────────────────
  //
  // These were `divide-x divide-y`, which Tailwind compiles to `> * + *` —
  // every child after the first, in DOM order, with no knowledge of rows or
  // columns. At `sm:grid-cols-3` that gave tiles 2 and 3 a top border inside
  // row one and tile 4 a left border at the start of row two. Drawing the
  // lines with the grid gap instead makes them follow the real geometry.
  //
  // Same treatment as `CostSummaryTiles`, and it carries the same constraint:
  // an empty grid track shows the container's border colour. Six tiles is the
  // one count that fills its rows at BOTH declared column counts, which is
  // why this grid needs no filler cells — and why the count is pinned here.
  test('draws the tile hairlines with the grid gap, never with divide utilities', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent detail={detail} isLoading={false} error={null} />,
    );

    const gridMatch = html.match(/<div class="[^"]*grid[^"]*grid-cols-2[^"]*"/);
    expect(gridMatch, 'expected the tile grid container').not.toBeNull();
    const grid = gridMatch![0];

    expect(grid).toContain('gap-px');
    expect(grid).toContain('bg-border');
    expect(grid).not.toContain('divide-x');
    expect(grid).not.toContain('divide-y');
  });

  test('renders exactly six tiles, so no grid track is left empty at either column count', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent detail={detail} isLoading={false} error={null} />,
    );

    const tiles = html.match(/<div class="bg-popover px-3 py-2\.5">/g) ?? [];
    expect(tiles).toHaveLength(6);
    // The layout declares `grid-cols-2 sm:grid-cols-3`; both must divide the
    // tile count exactly or an empty track renders as a block of border
    // colour under the gap-px hairlines.
    expect(tiles.length % 2).toBe(0);
    expect(tiles.length % 3).toBe(0);
  });
});
