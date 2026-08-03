import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ApiError,
  type SessionCostsPage,
  type SessionCostSort,
  type SessionCostSummary,
} from '@kortix/sdk';
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';

import { TableRow } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  buildSessionCostsListQuery,
  SESSION_COST_PAGE_SIZE,
} from '@/hooks/billing/use-session-costs';
import { BillingAccountProvider } from '@/stores/billing-account-context';

import { CostSortHeader } from './cost-sort-header';
import { collectElementsByType } from './react-element-tree';
import {
  applySessionSort,
  buildSessionsLevelExportFilters,
  buildSessionsLevelListInput,
  buildSessionsLevelOwnerCatalogInput,
  collectOwnerOptions,
  nextSessionSort,
  SessionsLevel,
  SessionsLevelTable,
  sessionSortDirection,
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

  // The dedupe keys on `owner_id`, not on the display label — two distinct
  // people who happen to share a name (or a name that collides with another
  // owner's email) must both survive as separate options, not collapse into
  // one. A label-keyed Map would merge these; only an id-keyed one is correct.
  test('keeps two different owners with the same display name as separate options', () => {
    const options = collectOwnerOptions([
      { owner_id: 'u1', owner_name: 'Alex Chen', owner_email: 'alex.chen@example.com' },
      { owner_id: 'u2', owner_name: 'Alex Chen', owner_email: 'alex.chen@other.example.com' },
    ] as never);
    expect(options).toEqual([
      { id: 'u1', label: 'Alex Chen' },
      { id: 'u2', label: 'Alex Chen' },
    ]);
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

describe('buildSessionsLevelExportFilters', () => {
  test('exports the same project, owner and sort the table is narrowed by', () => {
    expect(
      buildSessionsLevelExportFilters('project-1', {
        ownerId: 'owner-9',
        sort: 'recent',
        offset: 50,
      }),
    ).toEqual({ projectId: 'project-1', ownerId: 'owner-9', sort: 'recent' });
  });

  test('omits the owner filter (not a null) when no owner is selected', () => {
    // `costExportUrl` skips a falsy ownerId, so `null` would also never reach
    // the wire — asserted anyway because the export options type says
    // `ownerId?: string`, and a null there is a lie the compiler stops
    // catching the moment someone widens it.
    const filters = buildSessionsLevelExportFilters('project-1', {
      ownerId: null,
      sort: 'total_desc',
      offset: 0,
    });
    expect(filters.ownerId).toBeUndefined();
  });

  test('carries no page — the export is the whole filtered query, not the page on screen', () => {
    // `format=csv` hardcodes `limit: CSV_ROW_CAP, offset: 0` on the route, so
    // a page cannot narrow an export even if one were sent. Pinned so a
    // future "keep the export in sync with the table" change does not start
    // forwarding `filters.offset` in the belief that it does something.
    const filters = buildSessionsLevelExportFilters('project-1', {
      ownerId: null,
      sort: 'total_desc',
      offset: 75,
    });
    expect(filters).not.toHaveProperty('offset');
    expect(filters).not.toHaveProperty('limit');
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
      limit: 100,
      offset: 0,
      from: range.from,
      to: range.to,
      sort: 'total_desc',
    });
  });

  // The catalog fetch must use the API's actual ceiling (`MAX_COST_LIMIT` in
  // apps/api/src/shared/cost-window.ts), not the visible table's smaller
  // page — a fix-round finding caught this hardcoded to SESSION_COST_PAGE_SIZE
  // (25), silently missing any owner outside the top 25 sessions by spend.
  // Pinned as its own assertion (not folded into the test above) so a future
  // regression back to the table's page size fails on the exact number, not
  // just on "some field changed".
  test('uses a wider page than the visible table, not SESSION_COST_PAGE_SIZE', () => {
    const input = buildSessionsLevelOwnerCatalogInput('project-1', range);
    expect(input.limit).not.toBe(SESSION_COST_PAGE_SIZE);
    expect(input.limit).toBe(100);
  });
});

// ── Sorting: the pure half ─────────────────────────────────────────────────
//
// `renderToStaticMarkup` cannot fire a click, so what a header click does is
// asserted on the functions the handler calls. Each is the single place its
// rule lives, so a mutation to one produces a NAMED failure.

describe('nextSessionSort', () => {
  test('Total toggles between the two directions the route accepts', () => {
    expect(nextSessionSort('total_desc', 'total')).toBe('total_asc');
    expect(nextSessionSort('total_asc', 'total')).toBe('total_desc');
  });

  test('a first click on Total lands on descending, from any other sort', () => {
    expect(nextSessionSort('recent', 'total')).toBe('total_desc');
  });

  // `recent` is the only activity ordering `GET /usage/session-costs` has —
  // SESSION_COST_SORTS is exactly ['total_desc', 'total_asc', 'recent'] — so
  // Session is one-way. A repeat click must not invent an "oldest first".
  test('Session is one-way — a repeat click never asks for an ordering the API has no token for', () => {
    expect(nextSessionSort('total_desc', 'session')).toBe('recent');
    expect(nextSessionSort('recent', 'session')).toBe('recent');
  });

  test('every reachable result is a sort the route accepts', () => {
    const accepted: SessionCostSort[] = ['total_desc', 'total_asc', 'recent'];
    for (const active of accepted) {
      for (const column of ['session', 'total'] as const) {
        expect(accepted).toContain(nextSessionSort(active, column));
      }
    }
  });

  // `name_asc` is a valid ProjectCostSort and a 400 on this route. The session
  // headers must never produce it.
  test('never produces name_asc, which this route rejects', () => {
    const accepted: SessionCostSort[] = ['total_desc', 'total_asc', 'recent'];
    for (const active of accepted) {
      for (const column of ['session', 'total'] as const) {
        expect(nextSessionSort(active, column)).not.toBe('name_asc');
      }
    }
  });
});

describe('sessionSortDirection', () => {
  test('reports the active column and nothing else', () => {
    expect(sessionSortDirection('total_desc', 'total')).toBe('descending');
    expect(sessionSortDirection('total_desc', 'session')).toBeUndefined();

    expect(sessionSortDirection('total_asc', 'total')).toBe('ascending');
    expect(sessionSortDirection('total_asc', 'session')).toBeUndefined();
  });

  // `recent` is newest-first, which is descending by the date the Session
  // cell's second line shows.
  test('recent reads as descending on the Session column', () => {
    expect(sessionSortDirection('recent', 'session')).toBe('descending');
    expect(sessionSortDirection('recent', 'total')).toBeUndefined();
  });

  test('never returns the string "none" — the attribute is absent instead', () => {
    const sorts: SessionCostSort[] = ['total_desc', 'total_asc', 'recent'];
    for (const sort of sorts) {
      for (const column of ['session', 'total'] as const) {
        expect(sessionSortDirection(sort, column)).not.toBe('none');
      }
    }
  });
});

// ── The page reset — this is the mutation target ───────────────────────────
//
// An offset indexes an ORDERED result, so it means something different under a
// different order. `applySessionSort` is the only path that changes this
// level's sort; mutating its `offset: 0` back to `filters.offset` must fail the
// named test below.

describe('applySessionSort', () => {
  test('resets to page 1 — a mid-list offset does not survive a sort change', () => {
    expect(applySessionSort({ ownerId: null, sort: 'total_desc', offset: 50 }, 'total')).toEqual({
      ownerId: null,
      sort: 'total_asc',
      offset: 0,
    });
  });

  test('resets to page 1 on the Session column too, not just Total', () => {
    expect(applySessionSort({ ownerId: null, sort: 'total_desc', offset: 25 }, 'session')).toEqual({
      ownerId: null,
      sort: 'recent',
      offset: 0,
    });
  });

  // Session is one-way, so a repeat click leaves the sort alone — but the page
  // still resets. The reader asked for an ordering; answering from page 3 is
  // the same disorientation whether or not the order actually moved.
  test('resets the page even when the sort itself does not change', () => {
    expect(applySessionSort({ ownerId: null, sort: 'recent', offset: 75 }, 'session')).toEqual({
      ownerId: null,
      sort: 'recent',
      offset: 0,
    });
  });

  // The owner filter is a separate dimension and must survive a sort change —
  // re-sorting is not a request to widen the scope back to every owner.
  test('preserves the owner filter', () => {
    expect(applySessionSort({ ownerId: 'owner-9', sort: 'total_desc', offset: 25 }, 'total')).toEqual(
      { ownerId: 'owner-9', sort: 'total_asc', offset: 0 },
    );
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
        sort="total_desc"
        onSort={noop}
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
        sort="total_desc"
        onSort={noop}
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
        sort="total_desc"
        onSort={noop}
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

  // Defect 2. This footer sums `sessions` — one page — while the Total tile
  // rendered above the table by `CostLevelShell` is the project's whole
  // window, from `/usage/cost-summary`. Measured on the seed account's
  // largest project over 2026-07-01..2026-08-03: 55 sessions totalling
  // $24.2324, top 25 of them $24.1103. Both figures are right; they are not
  // the same quantity, so they do not share a label.
  test('the footer row is labelled "Page total", never a bare "Total"', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={{ ...page, total: 55, next_offset: 25 }}
        isLoading={false}
        error={null}
        sort="total_desc"
        onSort={noop}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );

    const footerMatch = html.match(/<tfoot[^>]*>[\s\S]*?<\/tfoot>/);
    expect(footerMatch).not.toBeNull();
    expect(footerMatch![0]).toContain('Page total');
    expect(footerMatch![0]).not.toContain('>Total<');
    // The page subtotal, not the 55-session figure the tile would show.
    expect(footerMatch![0]).toContain('$5.00');
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
      sort: 'total_desc',
      onSort: noop,
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

  // ── Sortable headers ──────────────────────────────────────────────────
  //
  // Only Session and Total, because those are the only two orderings
  // `GET /usage/session-costs` accepts. Owner, Requests, LLM and Compute have
  // no server sort, so they stay plain rather than becoming dead controls.

  /** The table's `<thead>`, so header assertions cannot pass by matching a
   *  body cell or the footer. */
  function headerHtml(sort: SessionCostSort = 'total_desc'): string {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={page}
        isLoading={false}
        error={null}
        sort={sort}
        onSort={noop}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    const match = html.match(/<thead[\s\S]*?<\/thead>/);
    expect(match, 'expected a table header').not.toBeNull();
    return match![0];
  }

  test('Session and Total are buttons; Owner, Requests, LLM and Compute are not', () => {
    const header = headerHtml();
    expect((header.match(/<button/g) ?? []).length).toBe(2);

    // Per cell — a whole-header count would pass with the buttons on the
    // wrong two columns.
    const cells = header.match(/<th[\s\S]*?<\/th>/g) ?? [];
    expect(cells).toHaveLength(6);
    expect(cells.map((cell) => cell.includes('<button'))).toEqual([
      true, // Session
      false, // Owner
      false, // Requests
      false, // LLM
      false, // Compute
      true, // Total
    ]);
  });

  test('the sortable headers are real buttons with a visible focus ring', () => {
    for (const button of headerHtml().match(/<button[^>]*>/g) ?? []) {
      expect(button).toContain('type="button"');
      expect(button).toContain('focus-visible:ring-2');
    }
  });

  test('aria-sort marks only the active column', () => {
    const descending = headerHtml('total_desc');
    expect((descending.match(/aria-sort=/g) ?? []).length).toBe(1);
    expect(descending).toContain('aria-sort="descending"');

    const ascending = headerHtml('total_asc');
    expect((ascending.match(/aria-sort=/g) ?? []).length).toBe(1);
    expect(ascending).toContain('aria-sort="ascending"');
  });

  test('aria-sort moves to the Session column under the recent sort', () => {
    const header = headerHtml('recent');
    const sessionCell = (header.match(/<th[\s\S]*?<\/th>/g) ?? [])[0]!;
    expect(sessionCell).toContain('aria-sort="descending"');
    expect((header.match(/aria-sort=/g) ?? []).length).toBe(1);
  });

  test('the Total header keeps the numeric right alignment', () => {
    const totalCell = (headerHtml().match(/<th[\s\S]*?<\/th>/g) ?? [])[5]!;
    expect(totalCell).toContain('text-right');
    expect(totalCell).not.toContain('float');
  });

  test('clicking a sortable header reports which column was clicked', () => {
    const clicked: string[] = [];
    const tree = SessionsLevelTable({
      data: page,
      isLoading: false,
      error: null,
      sort: 'total_desc',
      onSort: (column) => clicked.push(column),
      onSelectSession: noop,
      onPreviousPage: noop,
      onNextPage: noop,
    });

    const headers = collectElementsByType(tree, CostSortHeader);
    expect(headers.map((header) => header.props.label)).toEqual(['Session', 'Total']);

    (headers[0]!.props.onSort as () => void)();
    (headers[1]!.props.onSort as () => void)();
    expect(clicked).toEqual(['session', 'total']);
  });

  test('shows the loading skeleton, not an empty table, while the first fetch is in flight', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={undefined}
        isLoading={true}
        error={null}
        sort="total_desc"
        onSort={noop}
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
        sort="total_desc"
        onSort={noop}
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
        sort="total_desc"
        onSort={noop}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).toContain('No sessions');
  });

  // ── "no page was ever read" is not "this project has no sessions" ────────
  //
  // The empty state is a factual claim about the data. It may only render
  // once a page has actually come back. Every React Query state that is
  // neither `success` nor `error` — `pending`+`idle` (query disabled while
  // the billing account id resolves, fetch never started, fetch cancelled)
  // and `pending`+`paused` (retry loop paused: hidden document, or offline)
  // — reports `isLoading: false`, `error: null`, `data: undefined`. Gating
  // the skeleton on `isLoading && !data` let all of those fall through to
  // "No sessions", which is how a 500 on `/usage/session-costs` presented as
  // "this project has no sessions" during Task 15's live check.
  test('renders the loading state, not "No sessions", when no page has been read and nothing is in flight', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={undefined}
        isLoading={false}
        error={null}
        sort="total_desc"
        onSort={noop}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).not.toContain('No sessions');
    expect(html).toContain('aria-label="Loading sessions"');
  });

  // Ordering lock: a failed refetch on top of an already-read empty page has
  // BOTH an error and a zero-session page. The error must win. Checking the
  // empty branch first would swallow the failure exactly the way the
  // never-read case did.
  test('a failed refetch over an already-read empty page shows the error, not the empty state', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={{ ...page, sessions: [], total: 0 }}
        isLoading={false}
        error={new Error('upstream unavailable')}
        sort="total_desc"
        onSort={noop}
        onSelectSession={noop}
        onPreviousPage={noop}
        onNextPage={noop}
      />,
    );
    expect(html).toContain('Failed to load sessions');
    expect(html).toContain('upstream unavailable');
    expect(html).not.toContain('No sessions');
  });

  test('disables Previous on the first page and Next on the last page', () => {
    const html = renderToStaticMarkup(
      <SessionsLevelTable
        data={page}
        isLoading={false}
        error={null}
        sort="total_desc"
        onSort={noop}
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

// ── The state a failed /usage/session-costs request actually reaches ───────
//
// This is the reproduction of the live defect, not a hand-built prop triple:
// it drives the REAL query options (`buildSessionCostsListQuery`, the same
// builder `useSessionCosts` calls) through a real `QueryObserver` — the same
// object `useQuery` renders from — with a source that rejects with the real
// SDK `ApiError` carrying status 500, and asserts what the component is then
// handed.
//
// A rejected fetch does NOT always end in `status: 'error'`. React Query
// pauses the retry loop between attempts whenever the document is hidden or
// the browser is offline (`canContinue()` in query-core's `retryer.ts`
// checks `focusManager.isFocused()` and `onlineManager.isOnline()`), which
// dispatches `{ type: 'pause' }` -> `fetchStatus: 'paused'` with `status`
// still `pending` and `error` still null. `isLoading` is `isPending &&
// isFetching`, and a paused query is not fetching, so the component sees
// `isLoading: false` / `error: null` / `data: undefined` and stays there
// until focus returns.
describe('the state a failed /usage/session-costs request hands the table', () => {
  test('a paused retry reports isLoading false with a null error, and must not render as "No sessions"', async () => {
    // Not focused => the retry loop pauses instead of running to `error`.
    // Restored in `finally`: focusManager is a process-wide singleton.
    focusManager.setFocused(false);
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          // The app's own retry predicate (react-query-provider.tsx): a 500
          // is retried, so the fetch enters the retry loop where the pause
          // happens. retryDelay is shortened only to keep the test fast —
          // the pause is triggered by focus, not by the delay's length.
          retry: (failureCount: number, error: unknown) => {
            const status = (error as { status?: number } | null)?.status;
            if (status != null && status >= 400 && status < 500) return false;
            return failureCount < 3;
          },
          retryDelay: 1,
        },
      },
    });

    try {
      const options = buildSessionCostsListQuery(
        {
          accountId: 'acct-1',
          projectId: 'project-1',
          limit: SESSION_COST_PAGE_SIZE,
          offset: 0,
          from: range.from,
          to: range.to,
          sort: 'total_desc',
        },
        {
          list: async () => {
            throw new ApiError('column reference "last_at" is ambiguous', { status: 500 });
          },
          get: (async () => {}) as never,
          projects: (async () => []) as never,
        },
      );
      const observer = new QueryObserver(client, client.defaultQueryOptions(options));
      const unsubscribe = observer.subscribe(() => {});

      const deadline = Date.now() + 3000;
      while (observer.getCurrentResult().fetchStatus !== 'paused' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // With the observer mounted and the query key unchanged, this is
      // exactly what `useQuery` returns for this frame.
      const result = observer.getCurrentResult();
      expect(result.fetchStatus).toBe('paused');
      expect(result.isLoading).toBe(false);
      expect(result.error).toBeNull();
      expect(result.data).toBeUndefined();

      const html = renderToStaticMarkup(
        <SessionsLevelTable
          data={result.data}
          isLoading={result.isLoading}
          // The narrowing `SessionsLevel` applies at the call site. It is not
          // what dropped the error here: there is no error to narrow.
          error={result.error instanceof Error ? result.error : null}
          sort="total_desc"
        onSort={noop}
        onSelectSession={noop}
          onPreviousPage={noop}
          onNextPage={noop}
        />,
      );
      expect(html).not.toContain('No sessions');

      unsubscribe();
      observer.destroy();
    } finally {
      focusManager.setFocused(true);
      client.clear();
    }
  });

  // Kills the "the rejection value was not an Error instance" hypothesis for
  // good: the value `unwrap` throws on a 500 is the SDK's `ApiError`, and it
  // survives `error instanceof Error` — so `SessionsLevel`'s narrowing at
  // sessions-level.tsx:450 is not what turned a real failure into null.
  test('a 500 that is allowed to settle produces an ApiError that survives the instanceof narrowing', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const options = buildSessionCostsListQuery(
        {
          accountId: 'acct-1',
          projectId: 'project-1',
          limit: SESSION_COST_PAGE_SIZE,
          offset: 0,
          from: range.from,
          to: range.to,
          sort: 'total_desc',
        },
        {
          list: async () => {
            throw new ApiError('column reference "last_at" is ambiguous', { status: 500 });
          },
          get: (async () => {}) as never,
          projects: (async () => []) as never,
        },
      );
      const observer = new QueryObserver(client, client.defaultQueryOptions(options));
      const unsubscribe = observer.subscribe(() => {});

      const deadline = Date.now() + 3000;
      while (observer.getCurrentResult().status !== 'error' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const result = observer.getCurrentResult();
      expect(result.status).toBe('error');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error).toBeInstanceOf(ApiError);

      const html = renderToStaticMarkup(
        <SessionsLevelTable
          data={result.data}
          isLoading={result.isLoading}
          error={result.error instanceof Error ? result.error : null}
          sort="total_desc"
        onSort={noop}
        onSelectSession={noop}
          onPreviousPage={noop}
          onNextPage={noop}
        />,
      );
      expect(html).toContain('Failed to load sessions');
      expect(html).toContain('column reference &quot;last_at&quot; is ambiguous');

      unsubscribe();
      observer.destroy();
    } finally {
      client.clear();
    }
  });
});

// `SessionsLevel` itself, not a stand-in: the export button lives in the
// control row this component assembles, so nothing below it can prove the
// control actually reaches the screen. `renderToStaticMarkup` runs no
// effects, and React Query subscribes (and therefore fetches) from an effect,
// so this renders the real component's first pass with no request going out.
describe('SessionsLevel', () => {
  function renderLevel(): string {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <BillingAccountProvider accountId="acc_1">
            <TooltipProvider>
              <SessionsLevel
                projectId="project-1"
                range={range}
                onRangeChange={() => {}}
                onSelectSession={() => {}}
              />
            </TooltipProvider>
          </BillingAccountProvider>
        </QueryClientProvider>,
      );
    } finally {
      client.clear();
    }
  }

  test('offers the CSV export in the control row, beside the owner filter', () => {
    const html = renderLevel();
    expect(html).toContain('Export CSV');
    expect(html).toContain('Filter sessions by owner');
  });

  // The sort `<Select>` ("Highest spend" / "Most recent") is removed. The
  // Total and Session column headers select both of those orderings directly,
  // and the headers additionally reach `total_asc`, which the Select never
  // offered. Two controls for one job is a state the reader has to reconcile —
  // a dropdown reading "Highest spend" next to a Total header showing an
  // ascending arrow — and the header is the one that says WHICH column it
  // orders, so it is the one that stays.
  test('the sort Select is gone — the column headers are the only sort control', () => {
    const html = renderLevel();
    expect(html).not.toContain('Sort sessions');
  });

  // Counted rather than matched on absent text: a Radix `Select` renders its
  // items in a portal, so "Highest spend" was never in the static markup even
  // when the control existed — asserting its absence would have passed before
  // the removal too. The TRIGGER does render, so counting triggers is what
  // actually distinguishes one Select from two.
  test('exactly one Select remains in the control row, and it is the owner filter', () => {
    const html = renderLevel();
    const triggers = html.match(/role="combobox"/g) ?? [];
    expect(triggers).toHaveLength(1);
    expect(html).toContain('aria-label="Filter sessions by owner"');
  });
});

