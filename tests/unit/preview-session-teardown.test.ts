import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconcilePlatinumPreviews,
  teardownPlatinumPreview,
} from '../src/core/sandbox-preview-providers';

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
  { id: 'host-feature', name: 'kortix-env-feature-x', state: 'running', ramMb: 16_384, metadata: { owner: 'kortix-branch-env' } },
  session('s7', 'kortix-preview-pr-7'),
  session('sfeature', 'kortix-env-feature-x'),
  session('sgone', 'kortix-preview-pr-1'),
  session('suntagged-idle', null, 'preview', 9),
  session('sdev', 'kortix-preview-pr-7', 'dev'),
];

let calls: string[] = [];

function stubPlatinum() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && parsed.pathname === '/v1/sandboxes') {
        return new Response(JSON.stringify({ rows: listing, has_more: false, total: listing.length }));
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

  it('the daily reconcile deletes a stale host, then stops orphaned and idle sessions only', async () => {
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
});
