import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { resolvePreset, type CostRange } from '@/components/ui/date-range-picker';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import {
  buildCostByWorkspaceQuery,
  buildCostSummaryQuery,
} from '@/hooks/billing/use-cost-explorer';
import {
  buildSessionCostDetailQuery,
  buildSessionCostsListQuery,
} from '@/hooks/billing/use-session-costs';

import {
  buildBreadcrumbCrumbs,
  CostExplorer,
  explorerClockKey,
  firstClickableCrumbIndex,
  nextClockAnchor,
  parseExplorerState,
  serializeExplorerState,
  useExplorerClockAnchor,
  type ClockAnchor,
  type ExplorerCrumb,
  type ExplorerState,
} from './cost-explorer';

/** A fixed instant for every parse that does not care when it happened. */
const NOW = new Date('2026-08-01T12:00:00.000Z');

// ── Pure function: parseExplorerState — the brief's own canonical tests ────

describe('parseExplorerState', () => {
  test('defaults to the 30 day preset at the workspaces level', () => {
    const state = parseExplorerState(new URLSearchParams(), NOW);
    expect(state.range.preset).toBe('30d');
    expect(state.workspaceId).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  test('reads the workspace and session levels', () => {
    const state = parseExplorerState(new URLSearchParams('workspace=p1&session=s1'), NOW);
    expect(state.workspaceId).toBe('p1');
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

  test('ignores a session without a workspace', () => {
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
    const held: ClockAnchor = { key: 'workspace=p1', now: NOW };
    let reads = 0;
    const anchor = nextClockAnchor(held, 'workspace=p1', () => {
      reads += 1;
      return new Date();
    });
    expect(anchor).toBe(held);
    expect(reads).toBe(0);
  });

  test('re-reads the clock when the URL changes, so the window advances on navigation', () => {
    const held: ClockAnchor = { key: '', now: NOW };
    const later = new Date(NOW.getTime() + 60_000);
    const anchor = nextClockAnchor(held, 'workspace=p1', () => later);
    expect(anchor).toEqual({ key: 'workspace=p1', now: later });
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
    expect(key('workspace=p1')).toBe(key(''));
    expect(key('workspace=p1&session=s1')).toBe(key(''));
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
    expect(key('range=7d&tab=transactions&workspace=p1')).toBe(key('range=7d'));
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

  test('drilling workspaces -> sessions -> session reads the clock once', () => {
    expect(walk(['', 'workspace=p1', 'workspace=p1&session=s1'])).toEqual({ reads: 1, windows: 1 });
  });

  // The whole point of finding 2: one window across the drill-down means the
  // three levels reconcile under the label they all show ("Last 30 days").
  test('Back up the hierarchy returns to the SAME window, so the cache still holds', () => {
    expect(walk(['', 'workspace=p1', 'workspace=p1&session=s1', 'workspace=p1', ''])).toEqual({
      reads: 1,
      windows: 1,
    });
  });

  test('an explicit range change DOES re-read the clock', () => {
    expect(walk(['', 'range=7d'])).toEqual({ reads: 2, windows: 2 });
  });

  test('a range change while drilled in re-reads once, not once per level', () => {
    expect(walk(['workspace=p1', 'range=7d&workspace=p1', 'range=7d&workspace=p1&session=s1'])).toEqual({
      reads: 2,
      windows: 2,
    });
  });

  // Paging, sorting and the owner filter live in `useState`, never in the URL,
  // so they cannot reach the key at all. Pinned as a URL-level invariant: if
  // any of them is ever promoted to a search param, this test is the tripwire
  // that says "and now it moves the window".
  test('repeated renders at one URL never re-read', () => {
    expect(walk(['workspace=p1', 'workspace=p1', 'workspace=p1', 'workspace=p1'])).toEqual({
      reads: 1,
      windows: 1,
    });
  });

});

// ── The hook itself, actually rendered ─────────────────────────────────────
//
// This is the piece the rest of the file cannot reach by reasoning about
// `nextClockAnchor` (pure) or about the source text. Replacing the hook body
// with `return nextClockAnchor(null, key, () => new Date()).now` — holding
// removed, storm fully restored — passed every other test in this file. So the
// hook gets rendered for real.
//
// `renderToStaticMarkup` needs no DOM globals and runs React's real
// render-phase update loop, which is exactly what this hook is: it adjusts
// state during render, React re-invokes the component before rendering any
// child, and the second pass must find a matching key and stop. 56 files in
// `apps/web` already render this way.
//
// What it still cannot do is fire events or run effects — so react-query never
// subscribes under it, and the request-count harness above stays as it is.

/** Renders `<Parent>` once and reports how many times each component ran. */
function renderAnchor(search: string) {
  let parentInvocations = 0;
  let childInvocations = 0;
  const windows: Date[] = [];

  function Child({ now }: { now: Date }) {
    childInvocations += 1;
    windows.push(now);
    return <span>{now.toISOString()}</span>;
  }

  function Parent() {
    parentInvocations += 1;
    return <Child now={useExplorerClockAnchor(new URLSearchParams(search))} />;
  }

  const markup = renderToStaticMarkup(<Parent />);
  return { parentInvocations, childInvocations, windows, markup };
}

describe('useExplorerClockAnchor (rendered)', () => {
  // The mutation this exists for: a hook that never holds renders in ONE pass,
  // because it never schedules the render-phase update. Two passes is the
  // signature of the state actually being adjusted and retained.
  test('adjusts state during render: two parent passes, one child render', () => {
    const { parentInvocations, childInvocations } = renderAnchor('range=7d');
    expect({ parentInvocations, childInvocations }).toEqual({
      parentInvocations: 2,
      childInvocations: 1,
    });
  });

  // The second pass must return the value the first pass computed, or a child
  // could render against a window its parent has already moved past.
  test('both passes agree, so the child renders exactly one window', () => {
    const { windows, markup } = renderAnchor('range=7d');
    expect(windows).toHaveLength(1);
    expect(markup).toBe(`<span>${windows[0]!.toISOString()}</span>`);
  });

  test('resolves a usable instant for the default landing URL', () => {
    const { windows } = renderAnchor('');
    expect(windows[0]).toBeInstanceOf(Date);
    expect(Number.isNaN(windows[0]!.getTime())) .toBe(false);
  });

  // The hook derives its own key from the params it is handed, so a caller
  // cannot widen it. Drill-down params are present here and must not appear in
  // the key — proven by the settle behaviour being identical either way.
  test('drill-down params do not change how the hook settles', () => {
    expect(renderAnchor('range=7d&workspace=p1&session=s1')).toMatchObject({
      parentInvocations: 2,
      childInvocations: 1,
    });
  });
});

// ── Navigation, through the real hook ──────────────────────────────────────
// The tests above walk `nextClockAnchor` directly. These drive the actual hook
// across a URL change, by having the parent adjust its OWN state during render
// to swap the params mid-render. Every pass records the instant the hook
// returned, so "did it re-read the clock" is answered by object identity: a
// held reading is the same object, a re-read is a new one even when the two
// land in the same millisecond.

/**
 * Render with `from`, swap to `to` during render, return the hook's value per
 * pass.
 *
 * Guards its own vacuity: every caller asserts over `seen`, and
 * `seen.every(...)` is trivially true at length 1, so a single-pass render
 * would pass its test while proving nothing.
 *
 * That guard is defence-in-depth for a future refactor of THIS helper, not a
 * live check — as written, no input can reach it, and both obvious routes to
 * it are closed for different reasons (both measured):
 *
 *  - `from === to` does not produce one pass. `search === from` then stays true
 *    forever, so the parent schedules render-phase updates without end and
 *    `renderToStaticMarkup` throws `Too many re-renders` on the line above,
 *    before the guard is reached.
 *  - Removing the swap entirely still gives `seen.length === 2`, because
 *    `useExplorerClockAnchor` is itself what drives the second pass: `held`
 *    starts `null`, so mounting always fires `setHeld` and React re-invokes the
 *    parent regardless of what this helper does.
 *
 * So the guard earns its place only if the hook ever stops adjusting state on
 * mount, which is exactly the change that would quietly hollow these tests out.
 *
 * The single mount is the point: a lazy-initializer probe in this parent counts
 * ONE invocation, so the URL swap really does drive one mount across a
 * navigation rather than two separate mounts. That is also why callers compare
 * with `toBe` — two mounts inside the same millisecond produce equal
 * `getTime()` but distinct identity, so value equality would pass against a
 * re-reading hook.
 */
function renderAcrossNavigation(from: string, to: string): Date[] {
  const seen: Date[] = [];

  function Parent() {
    const [search, setSearch] = useState(from);
    seen.push(useExplorerClockAnchor(new URLSearchParams(search)));
    if (search === from) setSearch(to);
    return null;
  }

  renderToStaticMarkup(<Parent />);
  expect(seen.length).toBeGreaterThan(1);
  return seen;
}

describe('useExplorerClockAnchor across a URL change (rendered)', () => {
  test('drilling into a workspace keeps the very same instant', () => {
    const seen = renderAcrossNavigation('range=7d', 'range=7d&workspace=p1');
    expect(seen.every((instant) => instant === seen[0])).toBe(true);
  });

  test('drilling into a session keeps the very same instant', () => {
    const seen = renderAcrossNavigation('range=7d&workspace=p1', 'range=7d&workspace=p1&session=s1');
    expect(seen.every((instant) => instant === seen[0])).toBe(true);
  });

  test('an unrelated param keeps the very same instant', () => {
    const seen = renderAcrossNavigation('range=7d', 'range=7d&tab=transactions');
    expect(seen.every((instant) => instant === seen[0])).toBe(true);
  });

  // The other direction: a range change is exactly when the window SHOULD move.
  test('changing the preset takes a new reading', () => {
    const seen = renderAcrossNavigation('range=7d', 'range=90d');
    expect(seen.at(-1)).not.toBe(seen[0]);
  });

  test('changing a custom range bound takes a new reading', () => {
    const seen = renderAcrossNavigation(
      'range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z',
      'range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-09T00:00:00.000Z',
    );
    expect(seen.at(-1)).not.toBe(seen[0]);
  });
});

// ── Pure function: serializeExplorerState ───────────────────────────────────

describe('serializeExplorerState', () => {
  test('omits the default preset and null levels', () => {
    const params = serializeExplorerState({
      range: resolvePreset('30d', NOW),
      workspaceId: null,
      sessionId: null,
    });
    expect(params.toString()).toBe('');
  });

  test('round-trips a custom range', () => {
    const range = { preset: 'custom', from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' } as const;
    expect(
      parseExplorerState(
        serializeExplorerState({ range, workspaceId: 'p1', sessionId: null }),
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
      workspaceId: null,
      sessionId: null,
    });
    expect(params.get('range')).toBe('7d');
  });

  // Mutation target: "stop ignoring a session without a workspace". Even if a
  // caller hands this function a malformed state (sessionId set, workspaceId
  // not), the wire format must never carry a dangling `session` param — L3
  // cannot resolve its parent crumb from that.
  test('never emits session without workspace, even from a malformed state', () => {
    const params = serializeExplorerState({
      range: resolvePreset('30d', NOW),
      workspaceId: null,
      sessionId: 's1',
    } as ExplorerState);
    expect(params.has('session')).toBe(false);
  });

  test('workspace and session both round-trip together', () => {
    const state: ExplorerState = { range: resolvePreset('30d', NOW), workspaceId: 'p1', sessionId: 's1' };
    const parsed = parseExplorerState(serializeExplorerState(state), NOW);
    expect(parsed.workspaceId).toBe('p1');
    expect(parsed.sessionId).toBe('s1');
  });
});

// ── Pure function: buildBreadcrumbCrumbs ────────────────────────────────────
// `Usage › <workspace> › <session prefix>` — each non-current crumb's `target`
// is the state that clicking it should push. Structural assertions on
// `target`, not just crumb count/labels, so a broken "clear the deeper
// level" guard fails a test rather than passing on label text alone (see the
// task report for the mutation checks these are built to catch).

const range = resolvePreset('30d', NOW);

describe('buildBreadcrumbCrumbs', () => {
  test('at the workspaces level, renders a single current Usage crumb', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, workspaceId: null, sessionId: null }, null);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({ key: 'usage', label: 'Usage', current: true });
  });

  test('at the sessions level, Usage is a clickable crumb that clears the workspace', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, workspaceId: 'p1', sessionId: null }, 'Alpha');
    expect(crumbs).toHaveLength(2);

    const usage = crumbs[0]!;
    expect(usage.current).toBe(false);
    expect(usage.target).toEqual({ range, workspaceId: null, sessionId: null });

    const workspace = crumbs[1]!;
    expect(workspace).toMatchObject({ key: 'workspace', label: 'Alpha', current: true });
  });

  test('at the session level, the workspace crumb clears the session but keeps the workspace', () => {
    const crumbs = buildBreadcrumbCrumbs(
      { range, workspaceId: 'p1', sessionId: 'session-abcdefgh-long-tail' },
      'Alpha',
    );
    expect(crumbs).toHaveLength(3);

    const usage = crumbs[0]!;
    expect(usage.target).toEqual({ range, workspaceId: null, sessionId: null });

    const workspace = crumbs[1]!;
    expect(workspace.current).toBe(false);
    expect(workspace.target).toEqual({ range, workspaceId: 'p1', sessionId: null });

    const session = crumbs[2]!;
    expect(session.current).toBe(true);
    expect(session.label).toBe('session-a');
  });

  // The active date range is shared state across all three levels — clearing
  // a deeper level must never reset it back to the default.
  test('every crumb target preserves the active (non-default) range', () => {
    const customRange = { preset: 'custom', from: 'F', to: 'T' } as const;
    const crumbs = buildBreadcrumbCrumbs(
      { range: customRange, workspaceId: 'p1', sessionId: 's1' },
      'Alpha',
    );
    for (const crumb of crumbs) {
      expect(crumb.target.range).toEqual(customRange);
    }
  });

  test('falls back to a truncated workspace id when no label has loaded yet', () => {
    const crumbs = buildBreadcrumbCrumbs(
      { range, workspaceId: 'ws_1234567890', sessionId: null },
      null,
    );
    expect(crumbs[1]!.label).toBe('ws_123456');
  });
});

// ── Pure function: firstClickableCrumbIndex ────────────────────────────────
//
// Which crumb gets the leading back chevron. The crumb MODEL is unchanged by
// this — the reported problem ("when you click on any user, you get confused
// about where to click to go back to see all the workspaces") is affordance, not
// routing — so this is the one new decision the rendering makes, and it is
// pulled out as a pure function rather than inlined as `index === 0`.

describe('firstClickableCrumbIndex', () => {
  test('at the workspaces level there is nowhere up, so no crumb carries the chevron', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, workspaceId: null, sessionId: null }, null);
    expect(firstClickableCrumbIndex(crumbs)).toBe(-1);
  });

  test('at the sessions level the Usage crumb carries it', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, workspaceId: 'p1', sessionId: null }, 'Alpha');
    expect(firstClickableCrumbIndex(crumbs)).toBe(0);
    expect(crumbs[0]!.key).toBe('usage');
  });

  // Two crumbs are clickable at the session level. Only the shallowest gets
  // the chevron — one "go up" target, not a row of them.
  test('at the session level only the shallowest clickable crumb carries it', () => {
    const crumbs = buildBreadcrumbCrumbs({ range, workspaceId: 'p1', sessionId: 's1' }, 'Alpha');
    expect(crumbs.filter((crumb) => !crumb.current)).toHaveLength(2);
    expect(firstClickableCrumbIndex(crumbs)).toBe(0);
  });

  // Keyed on `current`, not on the index. If the crumb model ever grows a
  // level, or the current level is not the last crumb, the chevron must still
  // land on a crumb a click can actually reach.
  test('skips a leading current crumb rather than assuming index 0 is clickable', () => {
    const crumbs = [
      { key: 'usage', label: 'Usage', current: true, target: {} },
      { key: 'workspace', label: 'Alpha', current: false, target: {} },
    ] as unknown as ExplorerCrumb[];
    expect(firstClickableCrumbIndex(crumbs)).toBe(1);
  });
});

// ── How to re-verify this file: mutate, and demand a NAMED failure ─────────
//
// Nearly every test below was written against a specific mutation, and several
// earlier versions of them passed against the very defect they advertised. So
// the check that matters is not "the suite is green" — it is "this mutation
// produces a named failing test". A mutation that leaves the suite green is a
// contradiction, and the counts alone will not tell you: two of the holes found
// in review were tests that passed while their sibling did all the work.
//
// The loop, for each mutation: confirm the baseline is 0 fail, apply the
// mutation, run, record WHICH tests failed by name, then revert and `diff` to
// confirm byte-identical. Treat zero failures as a finding about this file, not
// about the mutation.
//
// The mutations that currently have teeth, with the test that catches each:
//
//   parseExplorerState re-reads the clock      -> 'a later now does move the window'
//   nextClockAnchor early return deleted       -> 'returns the SAME object for the same key'
//   explorerClockKey returns params.toString() -> 'a drill-down does not change the key'
//   the hook bypasses explorerClockKey         -> 'drilling into a workspace keeps the very same instant'
//   the hook stops holding (body gutted)       -> 'two parent passes, one child render'
//   any level re-resolves its own window       -> that level's 'custom range … verbatim'
//
// Note the last one has to be written to dodge the clock-read count to be a
// fair test — e.g. `const C = Date; new C()` — or the count catches it for the
// wrong reason and the window assertion is never exercised.

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
//     window   workspaces level (2 queries)   sessions level (3 queries)
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
 *  produced 318 requests at the workspaces level, against the 2 asserted here. */
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
const costSources = { summary: empty, byWorkspace: empty };
const sessionSources = { list: empty, get: empty, workspaces: empty };

describe('cost explorer request count', () => {
  test('the workspaces level fetches each of its two queries exactly once', async () => {
    const counts = await countRequests('', [
      {
        name: 'cost-summary',
        build: (range) =>
          buildCostSummaryQuery({ accountId: 'acct', from: range.from, to: range.to }, costSources),
      },
      {
        name: 'cost-by-workspace',
        build: (range) =>
          buildCostByWorkspaceQuery(
            { accountId: 'acct', from: range.from, to: range.to, sort: 'total_desc', offset: 0 },
            costSources,
          ),
      },
    ]);

    expect(counts).toEqual({ 'cost-summary': 1, 'cost-by-workspace': 1 });
  });

  test('the sessions level fetches each of its three queries exactly once', async () => {
    const counts = await countRequests('workspace=p1', [
      {
        name: 'cost-summary',
        build: (range) =>
          buildCostSummaryQuery(
            { accountId: 'acct', workspaceId: 'p1', from: range.from, to: range.to },
            costSources,
          ),
      },
      {
        name: 'owner-catalog',
        build: (range) =>
          buildSessionCostsListQuery(
            { accountId: 'acct', workspaceId: 'p1', limit: 100, offset: 0, from: range.from, to: range.to, sort: 'total_desc' },
            sessionSources,
          ),
      },
      {
        name: 'session-list',
        build: (range) =>
          buildSessionCostsListQuery(
            { accountId: 'acct', workspaceId: 'p1', limit: 25, offset: 0, from: range.from, to: range.to, sort: 'total_desc' },
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
    const counts = await countRequests('workspace=p1&session=s1', [
      {
        name: 'cost-summary',
        build: (range) =>
          buildCostSummaryQuery(
            { accountId: 'acct', workspaceId: 'p1', sessionId: 's1', from: range.from, to: range.to },
            costSources,
          ),
      },
      {
        name: 'session-detail',
        build: () =>
          buildSessionCostDetailQuery(
            { accountId: 'acct', workspaceId: 'p1', sessionId: 's1' },
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

// ── The real CostExplorer, rendered ────────────────────────────────────────
//
// `useQuery` builds and registers its `Query` during render (via
// `getOptimisticResult` -> `queryCache.build`), so a static render of the real
// component exposes every query key it would fetch — without effects, and so
// without any fetch. That makes the whole chain assertable end to end:
// searchParams -> the anchor -> `parseExplorerState` -> the range -> all four
// query builders.
//
// The property under test is that ONE window reaches all of them. A level that
// resolved its own window would show a different `to` on one of these keys,
// which is the shape the original defect took between renders.

const staticRouter = {
  push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {},
} as never;

/** Static-render the explorer at `search`; return the query keys it built. */
function renderExplorer(search: string): { key: readonly unknown[]; window: string | null }[] {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppRouterContext.Provider value={staticRouter}>
        <PathnameContext.Provider value="/accounts/acct">
          <SearchParamsContext.Provider value={new URLSearchParams(search) as never}>
            <TooltipProvider>
              <BillingAccountProvider accountId="acct">
                <CostExplorer />
              </BillingAccountProvider>
            </TooltipProvider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>
    </QueryClientProvider>,
  );

  return client
    .getQueryCache()
    .getAll()
    .map((query) => {
      const scope = query.queryKey[2];
      const bounds =
        scope && typeof scope === 'object' && 'from' in scope
          ? `${(scope as { from?: string }).from}|${(scope as { to?: string }).to}`
          : null;
      return { key: query.queryKey, window: bounds };
    });
}

/** The distinct from|to windows across every window-keyed query in a render. */
const distinctWindows = (built: ReturnType<typeof renderExplorer>) =>
  new Set(built.map((entry) => entry.window).filter((window): window is string => window !== null));

/** An explicit window, and the `from|to` it must produce untouched. */
const CUSTOM_SEARCH = 'range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z';
const CUSTOM_WINDOW = '2026-07-01T00:00:00.000Z|2026-07-08T00:00:00.000Z';

const LEVELS = [
  { name: 'workspaces', drill: '', keys: ['workspaces', 'summary', 'by-workspace'] },
  { name: 'sessions', drill: 'workspace=p1', keys: ['workspaces', 'summary', 'list', 'list'] },
  { name: 'session ledger', drill: 'workspace=p1&session=s1', keys: ['workspaces', 'summary', 'detail'] },
] as const;

for (const level of LEVELS) {
  describe(`CostExplorer, ${level.name} level (rendered)`, () => {
    test('builds exactly the queries this level mounts', () => {
      expect(renderExplorer(level.drill).map((entry) => entry.key[1])).toEqual([...level.keys]);
    });

    test('every window-keyed query shares one window', () => {
      expect(distinctWindows(renderExplorer(level.drill)).size).toBe(1);
    });

    // The assertion above has teeth against PARTIAL divergence — one query
    // wired to a different window than its siblings — and none against
    // wholesale substitution. A whole static render completes inside one
    // millisecond, so a level that re-resolves the SAME preset from its own
    // clock read produces a byte-identical window; wire all of that level's
    // inputs to it and the queries still agree with each other. Measured: a
    // sessions level self-resolving all three inputs passed 60/60, five runs
    // running.
    //
    // A custom range is the clock-free control. Its bounds come off the URL and
    // no code path consults `now`, so the correct window is a known constant
    // that a self-resolved one cannot coincide with — whatever the preset and
    // however consistently it is applied.
    test('a custom range reaches every query key verbatim', () => {
      const search = level.drill ? `${CUSTOM_SEARCH}&${level.drill}` : CUSTOM_SEARCH;
      expect([...distinctWindows(renderExplorer(search))]).toEqual([CUSTOM_WINDOW]);
    });
  });
}

// ── The breadcrumb's affordance ────────────────────────────────────────────
//
// Jay, using the shipped feature: "when you click on any user, you get
// confused about where to click to go back to see all the workspaces."
//
// The crumb model already routed correctly — `buildBreadcrumbCrumbs` above is
// tested for it — so nothing here touches the model or the URL state. What was
// missing was that a parent crumb did not LOOK clickable: plain text with a
// pointer cursor, which only exists for someone already hovering it.
//
// renderToStaticMarkup cannot fire a click, so these assert the rendered
// affordance — the shapes a reader can perceive before clicking — and leave the
// routing to the pure-function tests.

/** Static-render the explorer at `search` and return its markup. */
function renderExplorerHtml(search: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AppRouterContext.Provider value={staticRouter}>
          <PathnameContext.Provider value="/accounts/acct">
            <SearchParamsContext.Provider value={new URLSearchParams(search) as never}>
              <TooltipProvider>
                <BillingAccountProvider accountId="acct">
                  <CostExplorer />
                </BillingAccountProvider>
              </TooltipProvider>
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

/** The breadcrumb `<nav>` only, so crumb assertions cannot pass by matching
 *  the level's own table or control row further down the page. */
function breadcrumbHtml(html: string): string {
  const match = html.match(/<nav aria-label="breadcrumb"[\s\S]*?<\/nav>/);
  expect(match, 'expected a breadcrumb nav in the rendered output').not.toBeNull();
  return match![0];
}

/** Each clickable crumb's own markup. Crumbs do not nest, so the non-greedy
 *  match is exact. */
function crumbButtons(html: string): string[] {
  return breadcrumbHtml(html).match(/<button[\s\S]*?<\/button>/g) ?? [];
}

/** Back chevrons across the crumbs — counted inside the buttons so the
 *  separators' own `<svg>`s are not mistaken for one. */
function chevronCount(html: string): number {
  return crumbButtons(html).reduce(
    (count, button) => count + (button.match(/<svg/g) ?? []).length,
    0,
  );
}

describe('CostExplorer breadcrumb affordance', () => {
  test('a parent crumb is a real button, so it is keyboard reachable', () => {
    const crumbs = breadcrumbHtml(renderExplorerHtml('workspace=p1'));
    expect(crumbs).toContain('<button');
    expect(crumbs).toContain('type="button"');
  });

  test('a parent crumb underlines and changes colour on hover, and shows a focus ring', () => {
    const crumbs = breadcrumbHtml(renderExplorerHtml('workspace=p1'));
    const button = crumbs.match(/<button[^>]*>/)![0];
    expect(button).toContain('hover:underline');
    expect(button).toContain('hover:text-foreground');
    // Keyboard users get nothing from a hover treatment. `hover:` in Tailwind
    // v4 is already scoped to `@media (hover: hover)`, so a touch device gets
    // nothing from it either — the focus ring is what covers both.
    expect(button).toContain('focus-visible:ring-2');
    expect(button).toContain('focus-visible:ring-ring/50');
  });

  // At least 40px of vertical hit area, without changing the row's density:
  // `py-2.5` on the crumb (10px + a 20px text line box + 10px = 40px) and
  // `-my-2.5` on the list, which gives the padding back to the layout.
  test('crumb hit areas are enlarged and the enlargement is cancelled at the list', () => {
    const crumbs = breadcrumbHtml(renderExplorerHtml('workspace=p1'));
    expect(crumbs.match(/<button[^>]*>/)![0]).toContain('py-2.5');
    expect(crumbs).toMatch(/<ol[^>]*class="[^"]*-my-2\.5/);
  });

  // The one "go up" target. One chevron, on the shallowest clickable crumb —
  // not one per crumb, and not a separate Back button beside the breadcrumb,
  // which would be a second control doing the crumb's job.
  //
  // Counted INSIDE the crumb buttons, not across the nav: `BreadcrumbSeparator`
  // renders its own `<svg>` between every pair of crumbs, so a nav-wide count
  // measures separators and would move with the drill-down depth.
  test('exactly one back chevron renders at the sessions level', () => {
    expect(chevronCount(renderExplorerHtml('workspace=p1'))).toBe(1);
  });

  test('still exactly one back chevron at the session level, where two crumbs are clickable', () => {
    const html = renderExplorerHtml('workspace=p1&session=s1');
    // Two clickable crumbs …
    expect(crumbButtons(html)).toHaveLength(2);
    // … and one chevron across both of them.
    expect(chevronCount(html)).toBe(1);
  });

  test('no back chevron at the workspaces level — there is nowhere up', () => {
    const html = renderExplorerHtml('');
    expect(crumbButtons(html)).toHaveLength(0);
    expect(chevronCount(html)).toBe(0);
  });

  // The current level must stay non-interactive. A crumb that pushes the state
  // it is already in is a control that does nothing.
  test('the current crumb stays a BreadcrumbPage, never a button', () => {
    const crumbs = breadcrumbHtml(renderExplorerHtml('workspace=p1'));
    expect(crumbs).toContain('aria-current="page"');
    const pageMatch = crumbs.match(/<span[^>]*aria-current="page"[^>]*>[\s\S]*?<\/span>/);
    expect(pageMatch).not.toBeNull();
    expect(pageMatch![0]).not.toContain('<button');
  });

  // No second mechanism for the same job. The breadcrumb is the way up; a
  // "Back" button beside it would be a duplicate with its own state to keep
  // right.
  test('no separate Back button is added anywhere on the page', () => {
    const html = renderExplorerHtml('workspace=p1&session=s1');
    expect(html).not.toMatch(/>\s*Back\s*</);
  });
});

// ── The component's wiring ─────────────────────────────────────────────────
//
// Everything above this point is behavioral. What is left for the source text
// is one narrow question: does anything in this FILE read the wall clock other
// than the anchor? A stray `new Date()` in the render body would move the
// window per render again, and no rendered test can see a line that is simply
// absent from the module under test.
//
// Scope honestly: this is a single counting assertion, not a wiring proof.
// `useExplorerClockAnchor` is proven by rendering it; the component's use of it
// is proven by nothing here — a component that ignored the hook's return and
// passed a constant would pass. That is not a realistic hazard (there is no
// clock left to read), but it is the boundary.
//
// Both of this suite's standing failures — `workspace-sidebar-header.test.ts:36`
// and `workspace-switcher-control.test.ts:56` — are `toContain('<className
// literal>')` on correct components. This assertion is a different shape (a
// count of a hazard, not an appearance), which is why it survives renames and
// reformatting, but it is still text and it is kept to the minimum that earns
// its place.
//
// Known hole, out of scope and filed as JAY-252: a clock reached through a
// helper — `export function clockNow()` elsewhere, called here — is invisible
// to a count of this file. Only a real request-count spec closes that.

/**
 * Source with comments removed, so prose about the clock never counts as a
 * clock read.
 *
 * A single scanner rather than two regex passes. The regex version had two
 * holes, both of which produce a FALSE RED on a correct file: a line comment
 * that mentions a block-comment opener made the block pass swallow real code
 * through to the next closer, and a `//` inside a string literal truncated the
 * line. Neither is reachable in the current file, which is exactly why they
 * would not have been found until someone hit one. Both are covered below.
 */
function stripComments(source: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'string' = 'code';
  let quote = '';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];

    if (mode === 'line') {
      if (char === '\n') { mode = 'code'; out += char; }
      continue;
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') { mode = 'code'; i += 1; }
      continue;
    }
    if (mode === 'string') {
      if (char === '\\') { out += char + (next ?? ''); i += 1; continue; }
      if (char === quote) mode = 'code';
      out += char;
      continue;
    }
    if (char === '/' && next === '/') { mode = 'line'; i += 1; continue; }
    if (char === '/' && next === '*') { mode = 'block'; i += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { mode = 'string'; quote = char; }
    out += char;
  }

  return out;
}

/** Every way this file could read the wall clock directly. */
const CLOCK_READ = /new Date\(|Date\.now\(/g;

describe('cost-explorer.tsx clock reads', () => {
  const code = stripComments(readFileSync(join(import.meta.dir, 'cost-explorer.tsx'), 'utf8'));

  test('the file reads the clock exactly once, and that read is the anchor', () => {
    expect(code.match(CLOCK_READ) ?? []).toHaveLength(1);

    const anchorBody = code.slice(code.indexOf('function useExplorerClockAnchor'));
    expect(anchorBody.match(CLOCK_READ) ?? []).toHaveLength(1);
  });

  // The stripper is load-bearing for that count, so it gets its own tests —
  // including the two shapes the regex version got wrong.
  describe('stripComments', () => {
    test('removes trailing and whole-line comments', () => {
      expect(stripComments('const a = 1; // new Date()')).toBe('const a = 1; ');
      expect(stripComments('// new Date()\nconst a = 1;')).toBe('\nconst a = 1;');
    });

    test('removes block comments, including multi-line', () => {
      expect(stripComments('/* new Date() */ const a = 1;')).toBe(' const a = 1;');
      expect(stripComments('/*\n new Date()\n*/const a = 1;')).toBe('const a = 1;');
    });

    test('a line comment containing /* does not swallow the code after it', () => {
      expect(stripComments('// opens /* here\nconst a = 1;')).toBe('\nconst a = 1;');
    });

    test('a // inside a string is not a comment', () => {
      expect(stripComments("const u = 'https://x.dev';")).toBe("const u = 'https://x.dev';");
      expect(stripComments('const u = "a // b";')).toBe('const u = "a // b";');
      expect(stripComments('const u = `a // b`;')).toBe('const u = `a // b`;');
    });

    test('an escaped quote does not end the string early', () => {
      expect(stripComments("const u = 'a\\'// b';")).toBe("const u = 'a\\'// b';");
    });

    test('leaves clock reads in real code alone', () => {
      expect(stripComments('const t = new Date(); // not new Date()')).toBe(
        'const t = new Date(); ',
      );
    });
  });
});
