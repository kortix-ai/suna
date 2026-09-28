import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  managedReposCreatedLastHour,
  reconcilePlatinumPreviews,
  runPlatinumPreviewSuite,
  teardownPlatinumPreview,
} from '../src/core/sandbox-preview-providers';
import { PREVIEW_SUITE_SUPERSEDED } from '../src/core/sandbox-preview';

// A fake Platinum control plane: one listing page, and a record of every
// mutating call. Synthetic ids only.
const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function session(id: string, owner: string | null, env = 'preview', idleHours = 0.5) {
  return {
    id,
    name: `kortix-${id}-a1`,
    state: 'running',
    ramMb: 4096,
    createdAt: ago(idleHours),
    lastActivityAt: ago(idleHours),
    metadata: {
      'kortix.managed': 'true',
      'kortix.env': env,
      'kortix.workload': 'session',
      ...(owner ? { 'kortix.instance': owner } : {}),
    },
  };
}

const listing = [
  { id: 'host-7', name: 'kortix-preview-pr-7', state: 'running', ramMb: 16_384, metadata: { owner: 'kortix-preview', pr_number: '7', git_sha: 'a'.repeat(40) } },
  { id: 'host-feature', name: 'kortix-env-feature-x', state: 'running', ramMb: 16_384, metadata: { owner: 'kortix-branch-env', pr_number: '9' } },
  session('s7', 'kortix-preview-pr-7'),
  session('sfeature', 'kortix-env-feature-x'),
  session('sgone', 'kortix-preview-pr-1'),
  session('suntagged-idle', null, 'preview', 9),
  session('sdev', 'kortix-preview-pr-7', 'dev'),
];

let calls: string[] = [];

function stubPlatinum(rows: unknown[] = listing, reread: Record<string, unknown> = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && parsed.pathname === '/v1/sandboxes') {
        return new Response(JSON.stringify({ rows, has_more: false, total: rows.length }));
      }
      const one = /^\/v1\/sandboxes\/([^/]+)$/.exec(parsed.pathname);
      if (method === 'GET' && one) {
        const row = reread[one[1]!] ?? (rows as Array<{ id: string }>).find((r) => r.id === one[1]);
        return new Response(JSON.stringify(row ?? {}), { status: row ? 200 : 404 });
      }
      calls.push(`${method} ${parsed.pathname}`);
      return new Response('{}');
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preview teardown and sweep against the provider API', () => {
  it('teardown stops the torn-down host sessions and deletes only the host', async () => {
    stubPlatinum();
    await teardownPlatinumPreview({ apiUrl: 'https://platinum.example.test', apiKey: 'k', prNumber: 7 });
    expect(calls).toEqual(['POST /v1/sandboxes/s7/stop', 'DELETE /v1/sandboxes/host-7']);
  });

  it('teardown of a branch environment finds its sessions by the branch host name', async () => {
    stubPlatinum();
    await teardownPlatinumPreview({ apiUrl: 'https://platinum.example.test', apiKey: 'k', branchEnv: 'feature/x' });
    expect(calls).toEqual(['POST /v1/sandboxes/sfeature/stop', 'DELETE /v1/sandboxes/host-feature']);
  });

  it('the hourly reconcile deletes a stale host, then stops orphaned and idle sessions only', async () => {
    stubPlatinum();
    await reconcilePlatinumPreviews({
      apiUrl: 'https://platinum.example.test',
      apiKey: 'k',
      // PR 7 is no longer open; the feature branch still exists.
      activePullRequests: new Map(),
      liveBranchSandboxNames: new Set(['kortix-env-feature-x']),
    });
    expect(calls).toEqual([
      'DELETE /v1/sandboxes/host-7',
      'POST /v1/sandboxes/s7/stop',
      'POST /v1/sandboxes/sgone/stop',
      'POST /v1/sandboxes/suntagged-idle/stop',
    ]);
    // Never a session delete, never a dev box, never the live branch host.
    expect(calls.some((call) => call.startsWith('DELETE') && !call.endsWith('host-7'))).toBe(false);
    expect(calls.some((call) => call.includes('sdev') || call.includes('sfeature'))).toBe(false);
  });

  it('the reconcile stops a branch host whose pull request closed, with its sessions, and deletes nothing more', async () => {
    stubPlatinum();
    await reconcilePlatinumPreviews({
      apiUrl: 'https://platinum.example.test',
      apiKey: 'k',
      // PR 7 is open at the listed SHA; the feature branch's PR 9 is not.
      activePullRequests: new Map([[7, 'a'.repeat(40)]]),
      liveBranchSandboxNames: new Set(['kortix-env-feature-x']),
    });
    expect(calls).toEqual([
      'POST /v1/sandboxes/sgone/stop',
      'POST /v1/sandboxes/suntagged-idle/stop',
      'POST /v1/sandboxes/sfeature/stop',
      'POST /v1/sandboxes/host-feature/stop',
    ]);
  });

  it('the reconcile keeps a host that a deploy started since the listing', async () => {
    const feature = listing.find((row) => row.id === 'host-feature')!;
    stubPlatinum(listing, { 'host-feature': { ...feature, lastActivityAt: new Date().toISOString(), metadata: { ...feature.metadata, pr_number: '7' } } });
    await reconcilePlatinumPreviews({
      apiUrl: 'https://platinum.example.test',
      apiKey: 'k',
      activePullRequests: new Map([[7, 'a'.repeat(40)]]),
      liveBranchSandboxNames: new Set(['kortix-env-feature-x']),
    });
    expect(calls.some((call) => call.includes('host-feature') || call.includes('sfeature'))).toBe(false);
  });

  it('a suite waits for pool headroom and never launches into a full pool once superseded', async () => {
    const full = Array.from({ length: 32 }, (_, i) => ({
      id: `h${i}`,
      name: `kortix-env-b${i}`,
      state: 'running',
      ramMb: 16_384,
      lastActivityAt: ago(0),
      metadata: { owner: 'kortix-branch-env', pr_number: String(i + 1) },
    }));
    stubPlatinum(full);
    const code = await runPlatinumPreviewSuite({
      repository: 'kortix-ai/suna',
      sha: 'b'.repeat(40),
      prNumber: 1,
      runId: '1',
      runAttempt: '1',
      root: '/tmp',
      sandboxId: 'h0',
      branchEnv: 'b0',
      platinum: { apiUrl: 'https://platinum.example.test', apiKey: 'k' },
      superseded: async () => true,
    });
    expect(code).toBe(PREVIEW_SUITE_SUPERSEDED);
    // Nothing written, executed, or stopped: the suite never started.
    expect(calls).toEqual([]);
  });

  it('counts managed repositories created in the last hour, and answers null when GitHub fails', async () => {
    const created = [0.1, 0.5, 0.9, 1.2, 5].map((hours) => ({ created_at: ago(hours) }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(created))));
    expect(await managedReposCreatedLastHour('org', 't', NOW)).toBe(3);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    expect(await managedReposCreatedLastHour('org', 't', NOW)).toBeNull();
  });
});
