import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionCostsPage, SessionCostSummary } from '@kortix/sdk';

import { TableRow } from '@/components/ui/table';
import { SESSION_COST_PAGE_SIZE } from '@/hooks/billing/use-session-costs';

import {
  buildSessionsLevelListInput,
  buildSessionsLevelOwnerCatalogInput,
  collectOwnerOptions,
  SessionsLevelTable,
} from './sessions-level';

const range = { preset: '30d' as const, from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };

// ── collectOwnerOptions — the brief's own canonical tests, verbatim ────────

describe('collectOwnerOptions', () => {
  test('deduplicates owners and prefers the display name', () => {
    const options = collectOwnerOptions([
      { owner_id: 'u1', owner_name: 'Marko Kraemer', owner_email: 'marko@example.com' },
      { owner_id: 'u1', owner_name: 'Marko Kraemer', owner_email: 'marko@example.com' },
      { owner_id: 'u2', owner_name: null, owner_email: 'veyris@example.com' },
    ] as never);
    expect(options).toEqual([
      { id: 'u1', label: 'Marko Kraemer' },
      { id: 'u2', label: 'veyris@example.com' },
    ]);
  });

  test('skips sessions with no owner', () => {
    expect(
      collectOwnerOptions([{ owner_id: null, owner_name: null, owner_email: null }] as never),
    ).toEqual([]);
  });

  test('sorts owners alphabetically', () => {
    const options = collectOwnerOptions([
      { owner_id: 'u2', owner_name: 'Zoe', owner_email: null },
      { owner_id: 'u1', owner_name: 'Adam', owner_email: null },
    ] as never);
    expect(options.map((option) => option.label)).toEqual(['Adam', 'Zoe']);
  });

  // Neither fixture above exercises "owner_id present but no name AND no
  // email" — a real, if rare, shape (see SessionCostOwnerType === 'unknown').
  // Locks the fallback in rather than leaving it unverified by inspection.
  test('falls back to a neutral label when an owner has neither a name nor an email', () => {
    const options = collectOwnerOptions([
      { owner_id: 'u3', owner_name: null, owner_email: null },
    ] as never);
    expect(options).toEqual([{ id: 'u3', label: 'Unknown owner' }]);
  });
});

// ── the pure query-input builders — this is what the "ownerId pass-through"
// mutation check targets, since the hook itself is real (react-query + the
// SDK's fetch) and is not mocked here ─────────────────────────────────────

describe('buildSessionsLevelListInput', () => {
  test('forwards the selected owner, sort and page to the session-costs query', () => {
    expect(
      buildSessionsLevelListInput('project-1', range, {
        ownerId: 'owner-9',
        sort: 'recent',
        offset: 50,
      }),
    ).toEqual({
      projectId: 'project-1',
      limit: SESSION_COST_PAGE_SIZE,
      offset: 50,
      from: range.from,
      to: range.to,
      sort: 'recent',
      ownerId: 'owner-9',
    });
  });

  test('omits the owner filter (not a null) when no owner is selected', () => {
    const input = buildSessionsLevelListInput('project-1', range, {
      ownerId: null,
      sort: 'total_desc',
      offset: 0,
    });
    expect(input.ownerId).toBeUndefined();
  });
});

describe('buildSessionsLevelOwnerCatalogInput', () => {
  test('always requests page one, spend-sorted, with no owner filter', () => {
    // Deliberately never includes ownerId, and always offset 0 — this is the
    // query that populates the Owner dropdown itself, so it must not be the
    // one narrowed by whichever owner happens to be selected right now (that
    // would collapse the dropdown to a single option the moment one is
    // picked).
    expect(buildSessionsLevelOwnerCatalogInput('project-1', range)).toEqual({
      projectId: 'project-1',
      limit: SESSION_COST_PAGE_SIZE,
      offset: 0,
      from: range.from,
      to: range.to,
      sort: 'total_desc',
    });
  });
});

// ── SessionsLevelTable — the presentational half, tested the way
// SessionCostExplorerContent / ProjectsLevelContent already are: plain props,
// renderToStaticMarkup, no react-query or Supabase context required ────────

function session(overrides: Partial<SessionCostSummary>): SessionCostSummary {
  return {
    session_id: 'session-default',
    project_id: 'project-1',
    project_name: 'Support workflows',
    owner_id: 'user-1',
    owner_type: 'user',
    owner_name: 'User Owner',
    owner_email: 'owner@example.test',
    status: 'stopped',
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-01T11:00:00.000Z',
    last_activity_at: '2026-07-01T11:00:00.000Z',
    llm_cost: 0,
    compute_cost: 0,
    total_cost: 0,
    request_count: 0,
    error_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    model_count: 1,
    compute_seconds: 0,
    ...overrides,
  };
}

const twoSessions: SessionCostSummary[] = [
  session({
    session_id: 'session-one',
    owner_name: 'Marko Kraemer',
    owner_email: 'marko@example.com',
    request_count: 3,
    llm_cost: 1.1,
    compute_cost: 0.4,
    total_cost: 1.5,
  }),
  session({
    session_id: 'session-two',
    owner_id: 'service-1',
    owner_type: 'service_account',
    owner_name: 'Build service',
    owner_email: null,
    request_count: 5,
    llm_cost: 2.2,
    compute_cost: 1.3,
    total_cost: 3.5,
  }),
];

const page: SessionCostsPage = {
  sessions: twoSessions,
  total: 2,
  limit: SESSION_COST_PAGE_SIZE,
  offset: 0,
  next_offset: null,
  reconciliation: {
    llm_cost: 0,
    compute_cost: 0,
    total_cost: 0,
    request_count: 0,
    compute_window_count: 0,
    compute_seconds: 0,
  },
};

const noop = () => {};

describe('SessionsLevelTable', () => {
  test('renders session, owner and cost cells', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={page}
        isLoading={false}
        error={null}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );

    expect(html).toContain('session-one');
    expect(html).toContain('Marko Kraemer');
    expect(html).toContain('Build service');
    expect(html).toContain('Service');
    expect(html).toContain('$1.10');
    expect(html).toContain('$3.50');
  });

  // Presence alone would still pass with the columns in any order — position
  // comparison is what actually proves the layout the brief specifies.
  test('renders columns in order: Session, Owner, Requests, LLM, Compute, Total', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={page}
        isLoading={false}
        error={null}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );

    const markers = ['>Session<', '>Owner<', '>Requests<', '>LLM<', '>Compute<', '>Total<'];
    const positions = markers.map((marker) => html.indexOf(marker));
    positions.forEach((position, index) => {
      expect(position, `expected to find ${markers[index]}`).toBeGreaterThan(-1);
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  // The totals are computed here independently from the raw fixture numbers,
  // not by calling the component's own summation helper — otherwise a broken
  // sum and its "expected" value would break identically and the test would
  // stay green.
  test('the totals footer equals the sum of the rendered rows', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={page}
        isLoading={false}
        error={null}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );

    expect(html).toContain('8'); // 3 + 5 requests
    expect(html).toContain('$3.30'); // 1.10 + 2.20 LLM
    expect(html).toContain('$1.70'); // 0.40 + 1.30 compute
    expect(html).toContain('$5.00'); // 1.50 + 3.50 total
  });

  // renderToStaticMarkup strips event-handler props from its HTML output, so
  // "is the row clickable" cannot be asserted with toContain. Calling the
  // (plain, hook-free) component function directly returns the real React
  // element tree instead, which onClick survives on.
  test('the whole row is clickable and calls onSelectSession with that session id', () => {
    const selected: string[] = [];
    const tree = SessionsLevelTable({
      data: page,
      isLoading: false,
      error: null,
      onSelectSession: (sessionId) => selected.push(sessionId),
      onPreviousPage: noop,
      onNextPage: noop,
    });

    const rows = collectElementsByType(tree, TableRow).filter(
      (row) => typeof row.props?.onClick === 'function',
    );
    // Exactly one clickable row per session — not the header row, not the
    // footer row, and not merely "at least one" clickable element anywhere.
    expect(rows).toHaveLength(twoSessions.length);

    (rows[0].props.onClick as () => void)();
    expect(selected).toEqual(['session-one']);

    (rows[1].props.onClick as () => void)();
    expect(selected).toEqual(['session-one', 'session-two']);
  });

  test('shows the loading skeleton, not an empty table, while the first fetch is in flight', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={undefined}
        isLoading={true}
        error={null}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).toContain('aria-label="Loading sessions"');
  });

  test('renders the error banner instead of the table on failure', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={undefined}
        isLoading={false}
        error={new Error('upstream unavailable')}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).toContain('Failed to load sessions');
    expect(html).toContain('upstream unavailable');
  });

  test('renders an explicit empty state', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={{ ...page, sessions: [], total: 0 }}
        isLoading={false}
        error={null}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).toContain('No sessions');
  });

  test('disables Previous on the first page and Next on the last page', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={page}
        isLoading={false}
        error={null}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).toContain('Showing 1-2 of 2 sessions');
    // Both buttons render disabled: offset 0 disables Previous, and
    // next_offset: null disables Next.
    const disabledCount = html.split('disabled=""').length - 1;
    expect(disabledCount).toBe(2);
  });
});

/** Test-only tree walker over a React element returned by calling a
 *  hook-free function component directly (not through ReactDOM/SSR) — walks
 *  `.props.children` looking for elements of the given `type`, without
 *  rendering or invoking any nested component functions. */
function collectElementsByType(
  node: unknown,
  type: unknown,
  acc: { type: unknown; props: Record<string, unknown> }[] = [],
): { type: unknown; props: Record<string, unknown> }[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectElementsByType(item, type, acc);
    return acc;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === type && element.props) {
    acc.push({ type: element.type, props: element.props });
  }
  if (element.props && 'children' in element.props) {
    collectElementsByType(element.props.children, type, acc);
  }
  return acc;
}
