// Platinum's orphan-box enumeration.
//
// The orphan-box reaper STOPS whatever this returns and does not find in the
// DB, and the Platinum org is shared across prod/dev/local — so the scoping
// filter is a safety control, not a nicety. These pin that a box is only ever
// returned when it carries THIS environment's ownership marker, is running, and
// has a readable creation time.
//
// It exists at all because Monitors introduced the first PERSISTENT Platinum
// box: everything else idle-stops natively, so nothing ever accumulated.

import { beforeEach, expect, mock, test } from 'bun:test';

const platinumConfig: Record<string, unknown> = {
  PLATINUM_API_KEY: 'pt_test',
  PLATINUM_API_URL: 'https://platinum.example.test',
  KORTIX_URL: 'https://api.example.test',
  INTERNAL_KORTIX_ENV: 'dev',
  PLATINUM_TEMPLATE: 'kortix-computer',
};
mock.module('../../config', () => ({
  config: platinumConfig,
  SANDBOX_VERSION: 'test-version',
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => null,
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.test',
}));

const MANAGED = { 'kortix.managed': 'true', 'kortix.env': 'dev' };

let pages: Array<Record<string, unknown>> = [];
let requested: string[] = [];

beforeEach(() => {
  pages = [];
  requested = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    requested.push(path);
    const offset = Number(new URL(String(url)).searchParams.get('offset') ?? '0');
    const page = pages[offset / 100] ?? { rows: [], has_more: false };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

test('returns only running boxes that carry this environment’s ownership marker', async () => {
  pages = [
    {
      rows: [
        { id: 'sbx_mine', state: 'running', metadata: MANAGED, created_at: '2026-08-12T00:00:00Z' },
        // Another environment's box in the same shared org.
        {
          id: 'sbx_prod',
          state: 'running',
          metadata: { 'kortix.managed': 'true', 'kortix.env': 'prod' },
          created_at: '2026-08-12T00:00:00Z',
        },
        // Pre-marker box: created before the metadata stamp landed. Skipped,
        // never reaped — the safe fail direction.
        { id: 'sbx_legacy', state: 'running', created_at: '2026-08-01T00:00:00Z' },
        // Ours, but not running: the reaper only stops running boxes.
        { id: 'sbx_stopped', state: 'stopped', metadata: MANAGED, created_at: '2026-08-12T00:00:00Z' },
      ],
      has_more: false,
    },
  ];

  const { PlatinumProvider } = await import('./platinum');
  const listed = await new PlatinumProvider().listManagedRunningSandboxes();

  expect(listed.map((box) => box.externalId)).toEqual(['sbx_mine']);
  expect(listed[0]!.createdAt?.toISOString()).toBe('2026-08-12T00:00:00.000Z');
});

test('pages until has_more is false', async () => {
  pages = [
    {
      rows: [{ id: 'sbx_a', state: 'running', metadata: MANAGED, created_at: '2026-08-12T00:00:00Z' }],
      has_more: true,
    },
    {
      rows: [{ id: 'sbx_b', state: 'running', metadata: MANAGED, created_at: '2026-08-12T00:00:00Z' }],
      has_more: false,
    },
  ];

  const { PlatinumProvider } = await import('./platinum');
  const listed = await new PlatinumProvider().listManagedRunningSandboxes();

  expect(listed.map((box) => box.externalId)).toEqual(['sbx_a', 'sbx_b']);
  expect(requested).toEqual([
    '/v1/sandboxes?paginated=true&limit=100&offset=0',
    '/v1/sandboxes?paginated=true&limit=100&offset=100',
  ]);
});

test('a box with no readable creation time reports createdAt null so the reaper skips it', async () => {
  pages = [
    { rows: [{ id: 'sbx_undated', state: 'running', metadata: MANAGED }], has_more: false },
  ];

  const { PlatinumProvider } = await import('./platinum');
  const listed = await new PlatinumProvider().listManagedRunningSandboxes();

  expect(listed).toEqual([{ externalId: 'sbx_undated', createdAt: null }]);
});

test('INSTANCE SCOPE: with KORTIX_INSTANCE_ID set, another instance’s box is skipped; own and unstamped boxes are listed', async () => {
  // Shared Platinum org + shared local DB: instance A must never stop instance
  // B's boxes (projects/instance-scope.ts). Boxes created before the stamp
  // carry no `kortix.instance` and stay everyone's — the safe direction.
  platinumConfig.KORTIX_INSTANCE_ID = 'wt-a';
  try {
    pages = [
      {
        rows: [
          { id: 'sbx_mine', state: 'running', metadata: { ...MANAGED, 'kortix.instance': 'wt-a' }, created_at: '2026-08-12T00:00:00Z' },
          { id: 'sbx_other', state: 'running', metadata: { ...MANAGED, 'kortix.instance': 'primary' }, created_at: '2026-08-12T00:00:00Z' },
          { id: 'sbx_unstamped', state: 'running', metadata: MANAGED, created_at: '2026-08-12T00:00:00Z' },
        ],
        has_more: false,
      },
    ];

    const { PlatinumProvider } = await import('./platinum');
    const listed = await new PlatinumProvider().listManagedRunningSandboxes();

    expect(listed.map((box) => box.externalId)).toEqual(['sbx_mine', 'sbx_unstamped']);
  } finally {
    delete platinumConfig.KORTIX_INSTANCE_ID;
  }
});

test('INSTANCE SCOPE off (unset): a stamped box from any instance is listed as before', async () => {
  pages = [
    {
      rows: [
        { id: 'sbx_other', state: 'running', metadata: { ...MANAGED, 'kortix.instance': 'primary' }, created_at: '2026-08-12T00:00:00Z' },
      ],
      has_more: false,
    },
  ];

  const { PlatinumProvider } = await import('./platinum');
  const listed = await new PlatinumProvider().listManagedRunningSandboxes();

  expect(listed.map((box) => box.externalId)).toEqual(['sbx_other']);
});
