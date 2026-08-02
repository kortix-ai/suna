import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApiError, type SessionCostsPage, type SessionCostSummary } from '@kortix/sdk';
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

import {
  buildSessionsLevelExportFilters,
  buildSessionsLevelListInput,
  buildSessionsLevelOwnerCatalogInput,
  collectOwnerOptions,
  SessionsLevel,
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

  test('offers the CSV export in the control row, beside the owner and sort filters', () => {
    const html = renderLevel();
    expect(html).toContain('Export CSV');
    expect(html).toContain('Filter sessions by owner');
    expect(html).toContain('Sort sessions');
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
