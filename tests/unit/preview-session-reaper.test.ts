import { describe, expect, it } from 'vitest';
import {
  type PlatinumListedSandbox,
  PLATINUM_POOL_MB_DEFAULT,
  formatPoolUsage,
  isPreviewSessionSandbox,
  poolCannotFit,
  previewHostNames,
  selectPreviewSessionsForTeardown,
  selectStalePreviewSessions,
  summarizePoolUsage,
} from '../src/core/preview-session-reaper';

// Synthetic listing shaped like `GET /v1/sandboxes?paginated=true` rows.
const NOW = Date.parse('2026-09-24T00:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function session(
  id: string,
  opts: { owner?: string; env?: string; state?: string; idleHours?: number; workload?: string } = {},
): PlatinumListedSandbox {
  const idle = opts.idleHours ?? 0;
  return {
    id,
    name: `kortix-${id}-a1`,
    state: opts.state ?? 'running',
    ramMb: 4096,
    createdAt: hoursAgo(idle + 0.1),
    startedAt: hoursAgo(idle + 0.1),
    lastActivityAt: hoursAgo(idle),
    metadata: {
      'kortix.managed': 'true',
      'kortix.env': opts.env ?? 'preview',
      'kortix.workload': opts.workload ?? 'session',
      ...(opts.owner ? { 'kortix.instance': opts.owner } : {}),
    },
  };
}

function host(name: string, owner: 'kortix-preview' | 'kortix-branch-env', state = 'running') {
  return {
    id: `host-${name}`,
    name,
    state,
    ramMb: 16_384,
    createdAt: hoursAgo(48),
    lastActivityAt: hoursAgo(48),
    metadata: { owner, pr_number: '1' },
  } satisfies PlatinumListedSandbox;
}

describe('preview session selection', () => {
  it('only ever selects preview session boxes, never hosts or other environments', () => {
    expect(isPreviewSessionSandbox(session('a'))).toBe(true);
    expect(isPreviewSessionSandbox(session('dev', { env: 'dev' }))).toBe(false);
    expect(isPreviewSessionSandbox(session('prod', { env: 'prod' }))).toBe(false);
    expect(isPreviewSessionSandbox(session('app', { workload: 'app' }))).toBe(false);
    expect(isPreviewSessionSandbox(host('kortix-env-main', 'kortix-branch-env'))).toBe(false);
    // A host that somehow carries session tags is still a host.
    expect(
      isPreviewSessionSandbox({
        ...session('x'),
        name: 'kortix-preview-pr-7',
      }),
    ).toBe(false);
    expect(isPreviewSessionSandbox({ ...session('y'), metadata: { ...session('y').metadata, owner: 'kortix-preview' } })).toBe(false);
    expect(isPreviewSessionSandbox({ id: 'bare', state: 'running' })).toBe(false);
  });

  it('teardown selects the running session boxes of exactly the deleted host', () => {
    const listing = [
      session('mine-1', { owner: 'kortix-preview-pr-7' }),
      session('mine-stopped', { owner: 'kortix-preview-pr-7', state: 'stopped' }),
      session('other', { owner: 'kortix-preview-pr-8' }),
      session('untagged'),
      session('dev-same-tag', { owner: 'kortix-preview-pr-7', env: 'dev' }),
      host('kortix-preview-pr-7', 'kortix-preview'),
    ];
    expect(selectPreviewSessionsForTeardown(listing, ['kortix-preview-pr-7'])).toEqual(['mine-1']);
    expect(selectPreviewSessionsForTeardown(listing, [])).toEqual([]);
    expect(selectPreviewSessionsForTeardown(listing, [''])).toEqual([]);
  });

  it('the sweep stops boxes whose host is gone and boxes idle past the limit', () => {
    const listing = [
      host('kortix-env-live', 'kortix-branch-env'),
      session('live-fresh', { owner: 'kortix-env-live', idleHours: 1 }),
      session('live-idle', { owner: 'kortix-env-live', idleHours: 7 }),
      session('orphan-fresh', { owner: 'kortix-preview-pr-99', idleHours: 0.2 }),
      session('untagged-fresh', { idleHours: 2 }),
      session('untagged-idle', { idleHours: 11.9 }),
      session('orphan-stopped', { owner: 'kortix-preview-pr-99', state: 'stopped' }),
      session('dev-idle', { env: 'dev', idleHours: 30 }),
    ];
    const stops = selectStalePreviewSessions(listing, {
      liveHostNames: previewHostNames(listing),
      nowMs: NOW,
    });
    expect(stops.map((stop) => [stop.id, stop.reason])).toEqual([
      ['live-idle', 'idle'],
      ['orphan-fresh', 'owner-gone'],
      ['untagged-idle', 'idle'],
    ]);
    expect(stops.find((stop) => stop.id === 'live-idle')?.idleMinutes).toBe(420);
  });

  it('the 2026-09-23 shape: 87 untagged idle boxes are all selected, hosts are not', () => {
    const listing = [
      ...Array.from({ length: 9 }, (_, i) => host(`kortix-env-b${i}`, 'kortix-branch-env')),
      ...Array.from({ length: 42 }, (_, i) => session(`old-${i}`, { idleHours: 6.5 })),
      ...Array.from({ length: 45 }, (_, i) => session(`new-${i}`, { idleHours: 2 })),
    ];
    const before = summarizePoolUsage(listing);
    expect(before.usedMb).toBe(9 * 16_384 + 87 * 4096);
    const stops = selectStalePreviewSessions(listing, {
      liveHostNames: previewHostNames(listing),
      nowMs: NOW,
    });
    expect(stops).toHaveLength(42);
    expect(stops.every((stop) => stop.id.startsWith('old-'))).toBe(true);
    // A tighter limit reaches the rest.
    expect(
      selectStalePreviewSessions(listing, {
        liveHostNames: previewHostNames(listing),
        nowMs: NOW,
        maxIdleMs: 60 * 60_000,
      }),
    ).toHaveLength(87);
  });

  it('never judges a box idle without a parseable timestamp', () => {
    const undated: PlatinumListedSandbox = {
      ...session('undated', { idleHours: 100 }),
      createdAt: null,
      startedAt: null,
      lastActivityAt: 'not-a-date',
    };
    expect(
      selectStalePreviewSessions([undated], { liveHostNames: new Set(), nowMs: NOW }),
    ).toEqual([]);
  });
});

describe('pool headroom report', () => {
  it('names the top consumers by RAM and computes free space', () => {
    const listing = [
      host('kortix-env-a', 'kortix-branch-env'),
      ...Array.from({ length: 5 }, (_, i) => session(`s${i}`, { owner: 'kortix-env-a' })),
      ...Array.from({ length: 2 }, (_, i) => session(`u${i}`)),
      session('d', { env: 'dev' }),
      session('stopped', { state: 'stopped' }),
    ];
    const usage = summarizePoolUsage(listing, 65_536);
    expect(usage.running).toBe(9);
    expect(usage.usedMb).toBe(16_384 + 8 * 4096);
    expect(usage.freeMb).toBe(65_536 - 16_384 - 8 * 4096);
    expect(usage.consumers.map((c) => [c.label, c.count])).toEqual([
      ['preview sessions of kortix-env-a', 5],
      ['preview host kortix-env-a', 1],
      ['preview sessions of an untagged preview', 2],
      ['dev session boxes', 1],
    ]);
    const text = formatPoolUsage(usage);
    expect(text).toContain('48 GB of 64 GB RAM in use by 9 running boxes, 16 GB free');
    expect(text).toContain('20 GB  5 x preview sessions of kortix-env-a');
    expect(poolCannotFit(usage, 16_384)).toBe(false);
    expect(poolCannotFit(usage, 16_385)).toBe(true);
    expect(poolCannotFit(usage, 0)).toBe(false);
  });

  it('defaults the pool to the size in the provider refusal', () => {
    expect(PLATINUM_POOL_MB_DEFAULT).toBe(524_288);
    expect(summarizePoolUsage([]).freeMb).toBe(524_288);
  });
});
