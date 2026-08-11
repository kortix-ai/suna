import { describe, expect, test } from 'bun:test';
import {
  buildRows,
  computePorts,
  effectivePorts,
  filterRows,
  parseListenPorts,
  renderDetail,
  renderRail,
  SHARED_SUPABASE_PORTS,
  sortRows,
  stripAnsi,
  toJsonRows,
  type ListRow,
  type Registry,
} from '../lib';

const entry = (name: string, slot: number, over: Partial<Registry['slots'][string]> = {}) => ({
  slot,
  workspaceId: `kortix-${name}`,
  path: `/repo/suna-${name}`,
  branch: name,
  ports: computePorts(slot),
  dbMode: 'shared' as const,
  createdAt: '2026-08-05T00:00:00.000Z',
  status: 'stopped' as const,
  ...over,
});

const registry = (...entries: [string, number, Partial<Registry['slots'][string]>?][]): Registry => ({
  version: 1,
  slots: Object.fromEntries(entries.map(([n, s, o]) => [n, entry(n, s, o)])),
});

const rowsOf = (reg: Registry, live: Set<number> | null = new Set()) => sortRows(buildRows(reg, live));
const plain = (lines: string[]) => lines.map(stripAnsi);

describe('parseListenPorts', () => {
  test('reads the port out of every lsof address form', () => {
    const out = ['p1', 'f7', 'n*:15000', 'f9', 'n127.0.0.1:15008', 'f3', 'n[::1]:8008'].join('\n');
    expect(parseListenPorts(out)).toEqual(new Set([15000, 15008, 8008]));
  });

  test('ignores non-address field records', () => {
    expect(parseListenPorts(['p1234', 'f7', 'cnode'].join('\n'))).toEqual(new Set());
  });

  test('empty output is an empty set, never a throw', () => {
    expect(parseListenPorts('')).toEqual(new Set());
  });
});

describe('buildRows', () => {
  test('a listening web OR api port marks the worktree live', () => {
    const reg = registry(['web-only', 0], ['api-only', 1], ['dead', 2]);
    const live = new Set([computePorts(0).web, computePorts(1).api]);
    const byName = Object.fromEntries(buildRows(reg, live).map((r) => [r.name, r.live]));
    expect(byName).toEqual({ 'web-only': true, 'api-only': true, dead: false });
  });

  test('falls back to the recorded status when the probe is unavailable', () => {
    const reg = registry(['a', 0, { status: 'running' }], ['b', 1, { status: 'stopped' }]);
    const byName = Object.fromEntries(buildRows(reg, null).map((r) => [r.name, r.live]));
    expect(byName).toEqual({ a: true, b: false });
  });
});

describe('sortRows', () => {
  test('running first, then by name — not by slot', () => {
    const reg = registry(['zebra', 0], ['alpha', 1], ['middle', 2]);
    const live = new Set([computePorts(0).web]);
    expect(sortRows(buildRows(reg, live)).map((r) => r.name)).toEqual(['zebra', 'alpha', 'middle']);
  });

  test('does not mutate its input', () => {
    const rows = buildRows(registry(['b', 0], ['a', 1]), new Set());
    const before = rows.map((r) => r.name);
    sortRows(rows);
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});

describe('renderRail alignment', () => {
  const reg = registry(['acp', 0], ['md-table', 1], ['virtualized-messages-rendering', 2], ['x', 3]);

  test('every port starts at the same column regardless of name length', () => {
    const lines = plain(renderRail(rowsOf(reg), { probed: true })).filter((l) => l.includes('localhost:'));
    expect(lines).toHaveLength(4);
    const cols = new Set(lines.map((l) => l.indexOf('localhost:')));
    expect(cols.size).toBe(1);
  });

  test('the leader reaches the port from the longest name too', () => {
    const lines = plain(renderRail(rowsOf(reg), { probed: true }));
    const longest = lines.find((l) => l.includes('virtualized-messages-rendering'))!;
    expect(longest).toMatch(/virtualized-messages-rendering ··· localhost:13200/);
  });

  test('a short name gets a longer rail, never a bare gap', () => {
    const line = plain(renderRail(rowsOf(reg), { probed: true })).find((l) => l.includes(' x '))!;
    expect(line).toMatch(/ x ·{30,} localhost:/);
  });

  test('the widest possible row still fits an 80-column terminal', () => {
    const maxName = 'a'.repeat(40);
    const lines = plain(renderRail(rowsOf(registry([maxName, 31])), { probed: true }));
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(80);
  });

  test('the api column drops rather than wrapping a narrow terminal', () => {
    const wide = plain(renderRail(rowsOf(reg), { probed: true, columns: 120 }));
    const narrow = plain(renderRail(rowsOf(reg), { probed: true, columns: 50 }));
    expect(wide.some((l) => l.includes('api :'))).toBe(true);
    expect(narrow.some((l) => l.includes('api :'))).toBe(false);
    expect(narrow.some((l) => l.includes('localhost:'))).toBe(true);
  });

  test('live rows are marked ● and idle rows ○', () => {
    const lines = plain(renderRail(rowsOf(reg, new Set([computePorts(1).web])), { probed: true }));
    expect(lines[0]).toContain('● md-table');
    expect(lines.filter((l) => l.includes('○'))).toHaveLength(3);
  });
});

describe('renderRail footer', () => {
  const footerOf = (...args: Parameters<typeof renderRail>) => plain(renderRail(...args)).at(-1)!;

  test('counts the rendered worktrees and the running ones', () => {
    const reg = registry(['a', 0], ['b', 1], ['c', 2]);
    expect(footerOf(rowsOf(reg, new Set([computePorts(0).api])), { probed: true }))
      .toContain('3 worktrees · 1 running');
  });

  test('names the shared Supabase ports while every row is shared', () => {
    expect(footerOf(rowsOf(registry(['a', 0])), { probed: true }))
      .toContain(`shared Supabase db :${SHARED_SUPABASE_PORTS.sbDb} studio :${SHARED_SUPABASE_PORTS.sbStudio}`);
  });

  test('stops asserting shared ports as soon as one worktree is isolated', () => {
    const reg = registry(['a', 0], ['b', 1, { dbMode: 'isolated' }]);
    const footer = footerOf(rowsOf(reg), { probed: true });
    expect(footer).toContain('mixed DB modes');
    expect(footer).not.toContain(String(SHARED_SUPABASE_PORTS.sbDb));
  });

  test('reports the filtered scope against the registry total', () => {
    const reg = registry(['a', 0], ['b', 1], ['c', 2]);
    expect(footerOf(filterRows(rowsOf(reg), 'a'), { probed: true, totalCount: 3 }))
      .toContain('1 of 3 worktrees');
  });

  test('says so when the status came from the registry instead of a probe', () => {
    expect(footerOf(rowsOf(registry(['a', 0]), null), { probed: false }))
      .toContain('status from registry (lsof unavailable)');
  });
});

describe('filterRows', () => {
  const rows = rowsOf(registry(['md-table', 0], ['model-selector', 1], ['mobile', 2]));

  test('matches a case-insensitive substring anywhere in the name', () => {
    expect(filterRows(rows, 'TABLE').map((r) => r.name)).toEqual(['md-table']);
    expect(filterRows(rows, 'mo').map((r) => r.name)).toEqual(['mobile', 'model-selector']);
  });

  test('returns nothing for a miss and everything for an empty query', () => {
    expect(filterRows(rows, 'nope')).toHaveLength(0);
    expect(filterRows(rows, '  ')).toHaveLength(3);
  });

  test('does not rewrite the query the way sanitizeName would', () => {
    expect(filterRows(rows, 'md_')).toHaveLength(0);
  });
});

describe('effectivePorts', () => {
  test('a shared worktree answers on the primary Supabase ports, not its slot block', () => {
    const p = effectivePorts({ ports: computePorts(7), dbMode: 'shared' });
    expect(p.sbDb).toBe(SHARED_SUPABASE_PORTS.sbDb);
    expect(p.sbStudio).toBe(SHARED_SUPABASE_PORTS.sbStudio);
    expect(p.web).toBe(computePorts(7).web);
  });

  test('an isolated worktree keeps its own slot-derived block', () => {
    expect(effectivePorts({ ports: computePorts(7), dbMode: 'isolated' })).toEqual(computePorts(7));
  });
});

describe('renderDetail', () => {
  const base: ListRow = rowsOf(registry(['md-table', 19]))[0]!;

  test('prints reachable web, api and studio URLs', () => {
    const out = plain(renderDetail(base, { probed: true })).join('\n');
    expect(out).toContain(`http://localhost:${computePorts(19).web}`);
    expect(out).toContain(`http://localhost:${computePorts(19).api}/v1`);
    expect(out).toContain(`http://localhost:${SHARED_SUPABASE_PORTS.sbStudio}`);
  });

  test('shows the branch only when it differs from the name', () => {
    expect(plain(renderDetail(base, { probed: true })).join('\n')).not.toContain('branch');
    const renamed = { ...base, branch: 'feat/other' };
    expect(plain(renderDetail(renamed, { probed: true })).join('\n')).toContain('feat/other');
  });

  test('surfaces registry drift without repairing it', () => {
    const drifted = { ...base, recordedStatus: 'running' as const, live: false };
    expect(plain(renderDetail(drifted, { probed: true }))[0]).toContain('registry says running');
  });

  test('stays silent about drift when the status was not probed', () => {
    const drifted = { ...base, recordedStatus: 'running' as const, live: false };
    expect(plain(renderDetail(drifted, { probed: false }))[0]).not.toContain('registry says');
  });
});

describe('toJsonRows', () => {
  test('emits effective ports, both statuses, and clickable URLs', () => {
    const reg = registry(['md-table', 19]);
    const [row] = toJsonRows(rowsOf(reg, new Set([computePorts(19).web])), { probed: true });
    expect(row).toMatchObject({
      name: 'md-table',
      slot: 19,
      dbMode: 'shared',
      status: 'running',
      recordedStatus: 'stopped',
      probed: true,
    });
    expect(row!.ports.web).toBe(13000 + 19 * 100);
    expect(row!.ports.sbStudio).toBe(SHARED_SUPABASE_PORTS.sbStudio);
    expect(row!.urls.web).toBe(`http://localhost:${computePorts(19).web}`);
  });

  test('publishes only ports something binds — never the reserved analytics/pooler pair', () => {
    const rows = rowsOf(registry(['a', 0], ['b', 1, { dbMode: 'isolated' }]));
    for (const row of toJsonRows(rows, { probed: true })) {
      expect(Object.keys(row.ports).sort()).toEqual(
        ['api', 'gateway', 'sbApi', 'sbDb', 'sbInbucket', 'sbStudio', 'web'],
      );
    }
  });

  test('carries no ANSI escapes, so the payload stays parseable', () => {
    const json = JSON.stringify(toJsonRows(rowsOf(registry(['a', 0])), { probed: true }));
    expect(json).not.toContain('\x1b');
    expect(JSON.parse(json)).toHaveLength(1);
  });
});
