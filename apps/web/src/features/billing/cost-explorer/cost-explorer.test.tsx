import { describe, expect, test } from 'bun:test';

import { resolvePreset } from '@/components/ui/date-range-picker';

import {
  buildBreadcrumbCrumbs,
  parseExplorerState,
  serializeExplorerState,
  type ExplorerState,
} from './cost-explorer';

// ── Pure function: parseExplorerState — the brief's own canonical tests ────

describe('parseExplorerState', () => {
  test('defaults to the 30 day preset at the projects level', () => {
    const state = parseExplorerState(new URLSearchParams());
    expect(state.range.preset).toBe('30d');
    expect(state.projectId).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  test('reads the project and session levels', () => {
    const state = parseExplorerState(new URLSearchParams('project=p1&session=s1'));
    expect(state.projectId).toBe('p1');
    expect(state.sessionId).toBe('s1');
  });

  test('reads an explicit custom range', () => {
    const state = parseExplorerState(
      new URLSearchParams('range=custom&from=2026-07-01T00:00:00.000Z&to=2026-07-08T00:00:00.000Z'),
    );
    expect(state.range).toMatchObject({ preset: 'custom', from: '2026-07-01T00:00:00.000Z' });
  });

  test('falls back to the default preset on an unknown range token', () => {
    expect(parseExplorerState(new URLSearchParams('range=forever')).range.preset).toBe('30d');
  });

  test('ignores a session without a project', () => {
    expect(parseExplorerState(new URLSearchParams('session=s1')).sessionId).toBeNull();
  });

  // Beyond the brief's five: a named preset other than the default round-trips
  // its token (re-derived against "now" at parse time — presets are windows
  // relative to the moment they're read, not frozen instants like a custom
  // range's explicit bounds).
  test('reads a non-default named preset', () => {
    const state = parseExplorerState(new URLSearchParams('range=7d'));
    expect(state.range.preset).toBe('7d');
  });

  // A malformed custom range (missing from/to) must not throw or produce an
  // invalid CostRange — it falls back to the default, same as an unknown token.
  test('falls back to the default preset when a custom range is missing from/to', () => {
    expect(parseExplorerState(new URLSearchParams('range=custom')).range.preset).toBe('30d');
  });
});

// ── Pure function: serializeExplorerState ───────────────────────────────────

describe('serializeExplorerState', () => {
  test('omits the default preset and null levels', () => {
    const params = serializeExplorerState({
      range: resolvePreset('30d', new Date()),
      projectId: null,
      sessionId: null,
    });
    expect(params.toString()).toBe('');
  });

  test('round-trips a custom range', () => {
    const range = { preset: 'custom', from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' } as const;
    expect(
      parseExplorerState(serializeExplorerState({ range, projectId: 'p1', sessionId: null })).range,
    ).toEqual(range);
  });

  // Mutation target: "stop omitting the default preset from the URL". If the
  // default-preset guard is dropped, this URL grows a `range=30d` (plus
  // from/to) it should never carry.
  test('a non-default preset IS serialized', () => {
    const params = serializeExplorerState({
      range: resolvePreset('7d', new Date()),
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
      range: resolvePreset('30d', new Date()),
      projectId: null,
      sessionId: 's1',
    } as ExplorerState);
    expect(params.has('session')).toBe(false);
  });

  test('project and session both round-trip together', () => {
    const state: ExplorerState = { range: resolvePreset('30d', new Date()), projectId: 'p1', sessionId: 's1' };
    const parsed = parseExplorerState(serializeExplorerState(state));
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

const range = resolvePreset('30d', new Date());

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
