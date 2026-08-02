import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { resolvePreset, type CostRange } from '@/components/ui/date-range-picker';
import { buildCostByProjectQuery, buildCostSummaryQuery } from '@/hooks/billing/use-cost-explorer';
import {
  buildSessionCostDetailQuery,
  buildSessionCostsListQuery,
} from '@/hooks/billing/use-session-costs';

import {
  buildBreadcrumbCrumbs,
  explorerClockKey,
  nextClockAnchor,
  parseExplorerState,
  serializeExplorerState,
  type ClockAnchor,
  type ExplorerState,
} from './cost-explorer';

/** A fixed instant for every parse that does not care when it happened. */
const NOW = new Date('2026-08-01T12:00:00.000Z');

// ── Pure function: parseExplorerState — the brief's own canonical tests ────

describe('parseExplorerState', () => {
  test('defaults to the 30 day preset at the projects level', () => {
    const state = parseExplorerState(new URLSearchParams(), NOW);
    expect(state.range.preset).toBe('30d');
    expect(state.projectId).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  test('reads the project and session levels', () => {
    const state = parseExplorerState(new URLSearchParams('project=p1&session=s1'), NOW);
    expect(state.projectId).toBe('p1');
    expect(state.sessionId).toBe('s1');
  });

  test('reads an explicit custom range', () => {
    const state = parseExplorerState(
      new URLSearchParams('range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z'),
      NOW,
    );
    expect(state.range).toMatchObject({ preset: 'custom', from: '2026-07-01T00:00:00.000Z' });
  });

  test('falls back to the default preset on an unknown range token', () => {
    expect(parseExplorerState(new URLSearchParams('range=forever'), NOW).range.preset).toBe('30d');
  });

  test('ignores a session without a project', () => {
    expect(parseExplorerState(new URLSearchParams('session=s1'), NOW).sessionId).toBeNull();
  });

  // Beyond the brief's five: a named preset other than the default round-trips
  // its token (resolved against the `now` the caller supplies — presets are
  // windows relative to a moment, not frozen instants like a custom range's
  // explicit bounds).
  test('reads a non-default named preset', () => {
    const state = parseExplorerState(new URLSearchParams('range=7d'), NOW);
    expect(state.range.preset).toBe('7d');
  });

  // A malformed custom range (missing from/to) must not throw or produce an
  // invalid CostRange — it falls back to the default, same as an unknown token.
  test('falls back to the default preset when a custom range is missing from/to', () => {
    expect(parseExplorerState(new URLSearchParams('range=custom'), NOW).range.preset).toBe('30d');
  });

  // ── Purity: the whole point of taking `now` as a parameter ───────────────
  // Both bounds land inside four React Query keys. If this function reads the
  // clock itself, the keys move every render (see the request-count tests at
  // the bottom of this file).

  test('is a pure function of its inputs — same params and same now, same window', () => {
    const params = new URLSearchParams();
    expect(parseExplorerState(params, NOW).range).toEqual(parseExplorerState(params, NOW).range);
  });

  test('two parses one millisecond apart resolve the same window from the same now', () => {
    const first = parseExplorerState(new URLSearchParams('range=7d'), NOW);
    const second = parseExplorerState(new URLSearchParams('range=7d'), new Date(NOW.getTime()));
    expect(second.range).toEqual(first.range);
  });

  test('a later now does move the window — presets stay relative, not frozen', () => {
    const later = parseExplorerState(
      new URLSearchParams('range=7d'),
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(later.range.to).not.toBe(parseExplorerState(new URLSearchParams('range=7d'), NOW).range.to);
  });

  // A custom range never consults `now` at all — it reads both bounds off the
  // URL. It was already stable before this fix and must stay that way.
  test('a custom range ignores now entirely', () => {
    const params = new URLSearchParams(
      'range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z',
    );
    expect(parseExplorerState(params, new Date(NOW.getTime() + 999_999)).range).toEqual(
      parseExplorerState(params, NOW).range,
    );
  });

  // ── UTC discipline ──────────────────────────────────────────────────────
  // Asserted on UTC calendar parts, never on `toISOString()`, and this file is
  // run under TZ=UTC, TZ=Asia/Calcutta (+5:30) and TZ=America/Los_Angeles (-7)
  // — a negative offset is the case that has slipped through on this branch
  // before. `resolvePreset` does arithmetic on the epoch and formats with
  // `toISOString`, so nothing here may depend on the host offset.

  test('resolves a preset window on UTC calendar parts, whatever the host offset', () => {
    const from = new Date(parseExplorerState(new URLSearchParams('range=7d'), NOW).range.from);
    expect(from.getUTCFullYear()).toBe(2026);
    expect(from.getUTCMonth()).toBe(6); // July — 0-indexed
    expect(from.getUTCDate()).toBe(25);
    expect(from.getUTCHours()).toBe(12);
  });

  test('the default preset spans exactly 30 days of epoch time, whatever the host offset', () => {
    const { from, to } = parseExplorerState(new URLSearchParams(), NOW).range;
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(30 * 86_400_000);
  });
});

// ── Pure function: nextClockAnchor ─────────────────────────────────────────
// The retention rule behind `useExplorerClockAnchor`. Split out of the hook so
// it can be driven with an injected clock instead of a rendered component.

describe('nextClockAnchor', () => {
  test('takes a reading when there is nothing held yet', () => {
    let reads = 0;
    const anchor = nextClockAnchor(null, '', () => {
      reads += 1;
      return NOW;
    });
    expect(reads).toBe(1);
    expect(anchor).toEqual({ key: '', now: NOW });
  });

  // Object identity, not just value equality: identity is what keeps the
  // resolved window — and every query key derived from it — stable.
  test('returns the SAME object for the same key, and never re-reads the clock', () => {
    const held: ClockAnchor = { key: 'project=p1', now: NOW };
    let reads = 0;
    const anchor = nextClockAnchor(held, 'project=p1', () => {
      reads += 1;
      return new Date();
    });
    expect(anchor).toBe(held);
    expect(reads).toBe(0);
  });

  test('re-reads the clock when the URL changes, so the window advances on navigation', () => {
    const held: ClockAnchor = { key: '', now: NOW };
    const later = new Date(NOW.getTime() + 60_000);
    const anchor = nextClockAnchor(held, 'project=p1', () => later);
    expect(anchor).toEqual({ key: 'project=p1', now: later });
  });

  // The empty search string is the explorer's own default landing URL. It must
  // be a real key, not a falsy value that forces a fresh reading every render.
  test('holds a reading taken for the empty (default landing) URL', () => {
    const held: ClockAnchor = { key: '', now: NOW };
    expect(nextClockAnchor(held, '', () => new Date())).toBe(held);
  });
});

// ── Pure function: explorerClockKey ────────────────────────────────────────
// Which URL changes are allowed to move the window. Drill-down is not one of
// them: the levels must agree on the window they report, and Back must be able
// to hit the cache the level above it already filled.

describe('explorerClockKey', () => {
  const key = (search: string) => explorerClockKey(new URLSearchParams(search));

  test('a drill-down does not change the key', () => {
    expect(key('project=p1')).toBe(key(''));
    expect(key('project=p1&session=s1')).toBe(key(''));
  });

  test('an explicit preset change does change the key', () => {
    expect(key('range=7d')).not.toBe(key(''));
    expect(key('range=90d')).not.toBe(key('range=7d'));
  });

  test('a custom range keys on both of its bounds', () => {
    const base = 'range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z';
    expect(key(base)).not.toBe(key(base.replace('07-08', '07-09')));
    expect(key(base)).not.toBe(key(base.replace('07-01', '07-02')));
  });

  // The page this explorer lives on already carries `?tab=…`, and may grow
  // more. None of it is the explorer's window.
  test('an unrelated param never disturbs the key', () => {
    expect(key('tab=transactions')).toBe(key(''));
    expect(key('range=7d&tab=transactions&project=p1')).toBe(key('range=7d'));
  });
});

// ── Navigation: which moves re-read the clock, and which do not ────────────
// Drives `nextClockAnchor` through real navigation sequences with a counting
// clock. This is the behavioral half of the design decision above.

describe('clock reads across a navigation sequence', () => {
  /** Walk the URLs a user visits, returning how many times the clock was read. */
  function walk(searches: string[]): { reads: number; windows: number } {
    let held: ClockAnchor | null = null;
    let reads = 0;
    const seen = new Set<number>();

    for (const search of searches) {
      const params = new URLSearchParams(search);
      held = nextClockAnchor(held, explorerClockKey(params), () => {
        reads += 1;
        return new Date(NOW.getTime() + reads);
      });
      seen.add(held.now.getTime());
    }

    return { reads, windows: seen.size };
  }

  test('drilling projects -> sessions -> session reads the clock once', () => {
    expect(walk(['', 'project=p1', 'project=p1&session=s1'])).toEqual({ reads: 1, windows: 1 });
  });

  // The whole point of finding 2: one window across the drill-down means the
  // three levels reconcile under the label they all show ("Last 30 days").
  test('Back up the hierarchy returns to the SAME window, so the cache still holds', () => {
    expect(walk(['', 'project=p1', 'project=p1&session=s1', 'project=p1', ''])).toEqual({
      reads: 1,
      windows: 1,
    });
  });

  test('an explicit range change DOES re-read the clock', () => {
    expect(walk(['', 'range=7d'])).toEqual({ reads: 2, windows: 2 });
  });

  test('a range change while drilled in re-reads once, not once per level', () => {
    expect(walk(['project=p1', 'range=7d&project=p1', 'range=7d&project=p1&session=s1'])).toEqual({
      reads: 2,
      windows: 2,
    });
  });

  // Paging, sorting and the owner filter live in `useState`, never in the URL,
  // so they cannot reach the key at all. Pinned as a URL-level invariant: if
  // any of them is ever promoted to a search param, this test is the tripwire
  // that says "and now it moves the window".
  test('repeated renders at one URL never re-read', () => {
    expect(walk(['project=p1', 'project=p1', 'project=p1', 'project=p1'])).toEqual({
      reads: 1,
      windows: 1,
    });
  });

  // `useExplorerClockAnchor` adjusts state during render, which React answers
  // by re-invoking the component before it renders any child. That only
  // terminates because the second pass finds a matching key and does NOT call
  // `setHeld` again. Modelled here — the hook body verbatim, driven twice the
  // way React drives it — because an unterminated version is an infinite
  // render loop, and no DOM-free test can observe that directly.
  test('adjusting state during render settles on the second pass', () => {
    let held: ClockAnchor | null = null;
    let reads = 0;
    let setHeldCalls = 0;

    const renderPass = (key: string) => {
      const anchor = nextClockAnchor(held, key, () => {
        reads += 1;
        return NOW;
      });
      if (anchor !== held) {
        setHeldCalls += 1;
        held = anchor; // what React does before re-invoking the component
      }
      return anchor.now;
    };

    const first = renderPass('|null|null');
    const second = renderPass('|null|null');

    expect(setHeldCalls).toBe(1); // mount only — the second pass is a no-op
    expect(reads).toBe(1);
    expect(second).toBe(first); // and no child ever sees a different window
  });
});

// ── Pure function: serializeExplorerState ───────────────────────────────────

describe('serializeExplorerState', () => {
  test('omits the default preset and null levels', () => {
    const params = serializeExplorerState({
      range: resolvePreset('30d', NOW),
      projectId: null,
      sessionId: null,
    });
    expect(params.toString()).toBe('');
  });

  test('round-trips a custom range', () => {
    const range = { preset: 'custom', from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' } as const;
    expect(
      parseExplorerState(
        serializeExplorerState({ range, projectId: 'p1', sessionId: null }),
        NOW,
      ).range,
    ).toEqual(range);
  });

  // Mutation target: "stop omitting the default preset from the URL". If the
  // default-preset guard is dropped, this URL grows a `range=30d` (plus
  // from/to) it should never carry.
  test('a non-default preset IS serialized', () => {
    const params = serializeExplorerState({
      range: resolvePreset('7d', NOW),
      projectId: null,
      sessionId: null,
    });
    expect(params.get('range')).toBe('7d');
  });

  // Mutation target: "stop ignoring a session without a project". Even if a
  // caller hands this function a malformed state (sessionId set, projectId
  // not), the wire format must never carry a dangling `session` param — L3
  // cannot resolve its parent crumb from that.
  test('never emits session without project, even from a malformed state', () => {
    const params = serializeExplorerState({
      range: resolvePreset('30d', NOW),
      projectId: null,
      sessionId: 's1',
    } as ExplorerState);
    expect(params.has('session')).toBe(false);
  });

  test('project and session both round-trip together', () => {
    const state: ExplorerState = { range: resolvePreset('30d', NOW), projectId: 'p1', sessionId: 's1' };
    const parsed = parseExplorerState(serializeExplorerState(state), NOW);
    expect(parsed.projectId).toBe('p1');
    expect(parsed.sessionId).toBe('s1');
  });
});

// ── Pure function: buildBreadcrumbCrumbs ────────────────────────────────────
// `Usage › <project> › <session prefix>` — each non-current crumb's `target`
// is the state that clicking it should push. Structural assertions on
// `target`, not just crumb count/labels, so a broken "clear the deeper
// level" guard fails a test rather than passing on label text alone (see the
// task report for the mutation checks these are built to catch).

const range = resolvePreset('30d', NOW);

describe('buildBreadcrumbCrumbs', () => {
  test('at the projects level, renders a single current Usage crumb', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, projectId: null, sessionId: null }, null);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({ key: 'usage', label: 'Usage', current: true });
  });

  test('at the sessions level, Usage is a clickable crumb that clears the project', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, projectId: 'p1', sessionId: null }, 'Alpha');
    expect(crumbs).toHaveLength(2);

    const usage = crumbs[0]!;
    expect(usage.current).toBe(false);
    expect(usage.target).toEqual({ range, projectId: null, sessionId: null });

    const project = crumbs[1]!;
    expect(project).toMatchObject({ key: 'project', label: 'Alpha', current: true });
  });

  test('at the session level, the project crumb clears the session but keeps the project', () => {
    const crumbs = buildBreadcrumbCrumbs(
      { range, projectId: 'p1', sessionId: 'session-abcdefgh-long-tail' },
      'Alpha',
    );
    expect(crumbs).toHaveLength(3);

    const usage = crumbs[0]!;
    expect(usage.target).toEqual({ range, projectId: null, sessionId: null });

    const project = crumbs[1]!;
    expect(project.current).toBe(false);
    expect(project.target).toEqual({ range, projectId: 'p1', sessionId: null });

    const session = crumbs[2]!;
    expect(session.current).toBe(true);
    expect(session.label).toBe('session-a');
  });

  // The active date range is shared state across all three levels — clearing
  // a deeper level must never reset it back to the default.
  test('every crumb target preserves the active (non-default) range', () => {
    const customRange = { preset: 'custom', from: 'F', to: 'T' } as const;
    const crumbs = buildBreadcrumbCrumbs(
      { range: customRange, projectId: 'p1', sessionId: 's1' },
      'Alpha',
    );
    for (const crumb of crumbs) {
      expect(crumb.target.range).toEqual(customRange);
    }
  });

  test('falls back to a truncated project id when no label has loaded yet', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, projectId: 'project-without-a-loaded-name', sessionId: null }, null);
    expect(crumbs[1]!.label).toBe('project-w');
  });
});

// ── Request count: the explorer must settle, not loop ──────────────────────
//
// The regression this guards is not "a wasted refetch". A resolved query
// re-renders the explorer; the re-render re-derives the window; a window that
// moved mints a new key; a new key has no cached data (no cost query carries
// `placeholderData` or `keepPreviousData`, deliberately) so it fetches; that
// fetch notifies and the cycle repeats. Measured on the unfixed code, which
// closes into a self-sustaining loop — one request per mounted query per
// cycle, for as long as the tab is open:
//
//     window   projects level (2 queries)   sessions level (3 queries)
//     100 ms   140 requests                 252 requests
//     200 ms   318 requests                 501 requests
//     800 ms   1330 requests                2010 requests
//
// The shape is the finding: linear in time-on-page, never converging, on the
// page that reports what people are spending. The absolute figures are not —
// they are this harness on this machine and they move with load (a repeat of
// the same sweep measured 733-813 cycles/s where the table implies ~830). A
// browser is slower again: it clamps nested `setTimeout` to 4 ms once the
// chain nests, and `Date`'s 1 ms resolution caps any environment near 1000
// cycles/s. So these tests assert "settles at one request", never a rate.
//
// `apps/web` has no DOM test environment (no jsdom/happy-dom, and registering
// one would leak globals into every other file — this suite runs without
// `--isolate`), so this drives the real cycle without React: real
// `QueryObserver`s over the real `build*Query` functions, re-deriving through
// the real `parseExplorerState` and `nextClockAnchor` on every notification.
// That is what `useBaseQuery` does — `observer.setOptions(...)` per render,
// re-render on notify — with `setTimeout(0)` standing in for React's
// scheduler. The wiring the component itself does is pinned separately below.

/** Long enough for a loop to be unmistakable: on the unfixed code this window
 *  produced 318 requests at the projects level, against the 2 asserted here. */
const REQUEST_WINDOW_MS = 150;
/** Bail out rather than hang if the loop ever returns. */
const REQUEST_CAP = 1_000;

interface MountedQuery {
  name: string;
  build: (range: CostRange) => { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };
}

/**
 * Mount `queries` for the explorer at `search`, drive the render cycle for a
 * fixed window, and report how many times each one actually fetched.
 */
async function countRequests(
  search: string,
  queries: MountedQuery[],
): Promise<Record<string, number>> {
  const params = new URLSearchParams(search);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  const counts: Record<string, number> = Object.fromEntries(queries.map((q) => [q.name, 0]));
  let total = 0;
  let stopped = false;

  // The component's own clock discipline, reproduced exactly: one reading per
  // range selection, held across renders.
  let anchor: ClockAnchor | null = null;
  const parse = () => {
    anchor = nextClockAnchor(anchor, explorerClockKey(params), () => new Date());
    return parseExplorerState(params, anchor.now).range;
  };

  const options = (query: MountedQuery, range: CostRange) => {
    const built = query.build(range);
    return {
      ...built,
      queryFn: async () => {
        counts[query.name] = (counts[query.name] ?? 0) + 1;
        total += 1;
        if (total >= REQUEST_CAP) stopped = true;
        return built.queryFn();
      },
    };
  };

  const observers = queries.map(
    (query) => new QueryObserver(client, options(query, parse()) as never),
  );

  let scheduled = false;
  const render = () => {
    scheduled = false;
    if (stopped) return;
    const range = parse();
    observers.forEach((observer, index) => observer.setOptions(options(queries[index]!, range) as never));
  };

  const unsubscribes = observers.map((observer) =>
    observer.subscribe(() => {
      if (scheduled || stopped) return;
      scheduled = true;
      setTimeout(render, 0);
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, REQUEST_WINDOW_MS));
  stopped = true;
  unsubscribes.forEach((unsubscribe) => unsubscribe());
  client.clear();

  return counts;
}

const empty = async () => ({}) as never;
const costSources = { summary: empty, byProject: empty };
const sessionSources = { list: empty, get: empty, projects: empty };

describe('cost explorer request count', () => {
  test('the projects level fetches each of its two queries exactly once', async () => {
    const counts = await countRequests('', [
      {
        name: 'cost-summary',
        build: (range) =>
          buildCostSummaryQuery({ accountId: 'acct', from: range.from, to: range.to }, costSources),
      },
      {
        name: 'cost-by-project',
        build: (range) =>
          buildCostByProjectQuery(
            { accountId: 'acct', from: range.from, to: range.to, sort: 'total_desc', offset: 0 },
            costSources,
          ),
      },
    ]);

    expect(counts).toEqual({ 'cost-summary': 1, 'cost-by-project': 1 });
  });

  test('the sessions level fetches each of its three queries exactly once', async () => {
    const counts = await countRequests('project=p1', [
      {
        name: 'cost-summary',
        build: (range) =>
          buildCostSummaryQuery(
            { accountId: 'acct', projectId: 'p1', from: range.from, to: range.to },
            costSources,
          ),
      },
      {
        name: 'owner-catalog',
        build: (range) =>
          buildSessionCostsListQuery(
            { accountId: 'acct', projectId: 'p1', limit: 100, offset: 0, from: range.from, to: range.to, sort: 'total_desc' },
            sessionSources,
          ),
      },
      {
        name: 'session-list',
        build: (range) =>
          buildSessionCostsListQuery(
            { accountId: 'acct', projectId: 'p1', limit: 25, offset: 0, from: range.from, to: range.to, sort: 'total_desc' },
            sessionSources,
          ),
      },
    ]);

    expect(counts).toEqual({ 'cost-summary': 1, 'owner-catalog': 1, 'session-list': 1 });
  });

  // L3. `useCostSummary` here is scoped to a single session but still carries
  // from/to, so it looped exactly like the levels above it. `useSessionCostDetail`
  // is NOT window-keyed (the ledger shows every finalized entry regardless of
  // the selected window) — it is mounted alongside to pin that it stays at one
  // request and never becomes window-keyed by accident.
  test('the session ledger level fetches each of its two queries exactly once', async () => {
    const counts = await countRequests('project=p1&session=s1', [
      {
        name: 'cost-summary',
        build: (range) =>
          buildCostSummaryQuery(
            { accountId: 'acct', projectId: 'p1', sessionId: 's1', from: range.from, to: range.to },
            costSources,
          ),
      },
      {
        name: 'session-detail',
        build: () =>
          buildSessionCostDetailQuery(
            { accountId: 'acct', projectId: 'p1', sessionId: 's1' },
            sessionSources,
          ),
      },
    ]);

    expect(counts).toEqual({ 'cost-summary': 1, 'session-detail': 1 });
  });

  // A custom range reads both bounds off the URL and never consults the clock,
  // so it was stable before this fix. Pinned so a future change to the clock
  // discipline cannot regress the one path that never needed it.
  test('an explicit custom range also fetches exactly once', async () => {
    const counts = await countRequests(
      'range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z',
      [
        {
          name: 'cost-summary',
          build: (range) =>
            buildCostSummaryQuery({ accountId: 'acct', from: range.from, to: range.to }, costSources),
        },
      ],
    );

    expect(counts).toEqual({ 'cost-summary': 1 });
  });
});

// ── The component's wiring ─────────────────────────────────────────────────
//
// `countRequests` above proves the cycle settles when the explorer resolves
// its window from a held reading. The one link a hookless harness cannot
// reach is whether `CostExplorer` actually does that, so it is pinned here by
// reading the source.
//
// Source assertions are a liability, and this file has to earn the exception.
// Both of this suite's standing failures — `project-sidebar-header.test.ts:36`
// and `project-switcher-control.test.ts:56` — are `toContain('<className
// literal>')` broken by cosmetic edits to correct components. They assert
// APPEARANCE, so any rewording breaks them and any behavior change slips past.
//
// These assert the ABSENCE OF A HAZARD instead, which is a different shape,
// and three rules keep them that way. Each was demonstrated to matter:
//
//  - Count clock reads across every spelling — `new Date(`, `Date.now(` — not
//    one literal. Counting `/new Date\(\)/g` alone lets `new Date(Date.now())`
//    through, which restores the entire loop with the suite still green.
//  - Never match on identifier names. Splitting the call across locals
//    (`const k = explorerClockKey(p); const now = useExplorerClockAnchor(k);`)
//    is semantically identical and must stay green.
//  - Strip comments properly, trailing ones included. Dropping only whole-line
//    comments lets a trailing `// … new Date() …` inflate the count and fail a
//    correct file.
//
// This still cannot see a clock injected through a helper or a `dayjs()`. Only
// a real mount closes that, and it is filed separately as a Playwright spec.

/** Comment-free source, so prose about the clock never counts as a clock read.
 *  Block comments first, then line comments — the `[^:]` guard keeps `://` in
 *  a URL from being treated as the start of one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every way this file could read the wall clock. */
const CLOCK_READ = /new Date\(|Date\.now\(/g;

describe('CostExplorer clock wiring', () => {
  const code = stripComments(readFileSync(join(import.meta.dir, 'cost-explorer.tsx'), 'utf8'));

  test('the file reads the clock exactly once, inside the anchor', () => {
    const reads = code.match(CLOCK_READ) ?? [];
    expect(reads).toHaveLength(1);

    // And that one read is the anchor's own, not some other line that happens
    // to be the only one left.
    const anchorBody = code.slice(code.indexOf('function useExplorerClockAnchor'));
    expect(anchorBody.match(CLOCK_READ) ?? []).toHaveLength(1);
  });

  // Asserted by dropping the declaration and checking the name still appears,
  // so splitting the call across locals stays green — that refactor changes
  // nothing about behavior and a stricter pattern match would reject it.
  test('the render body resolves its window through the anchor hook', () => {
    const calls = code.replace(/function useExplorerClockAnchor\b/, '');
    expect(calls).toContain('useExplorerClockAnchor(');
  });

  test('the anchor is keyed by the range params, not the whole URL', () => {
    const calls = code.replace(/export function explorerClockKey\b/, '');
    expect(calls).toContain('explorerClockKey(');
    // `searchParams.toString()` as a key is the round-1 behavior: it re-read
    // the clock on every drill-down and on Back.
    expect(code).not.toMatch(/useExplorerClockAnchor\([^)]*toString\(\)/);
  });

  // The hazard itself: a clock read reaching `parseExplorerState`, whatever it
  // is spelled or named. Caught regardless of how the arguments are formatted.
  test('no clock read is ever passed to parseExplorerState', () => {
    expect(code).not.toMatch(/parseExplorerState\([^)]*(new Date\(|Date\.now\()/);
  });

  // Guards the stripper itself. Without the trailing-comment branch this input
  // reads as two clock reads and a correct file fails.
  test('stripComments removes trailing and block comments, and spares URLs', () => {
    expect(stripComments('const a = 1; // new Date()')).toBe('const a = 1; ');
    expect(stripComments('/* new Date() */ const a = 1;')).toBe(' const a = 1;');
    expect(stripComments("const u = 'https://x.dev';")).toBe("const u = 'https://x.dev';");
  });
});
