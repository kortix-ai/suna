// Gateway-URL convergence at API boot.
//
// 2026-08-22, evening, repeatedly: a sandbox's OpenCode is configured at boot
// with KORTIX_LLM_BASE_URL derived from the API's KORTIX_URL. On dev the
// cloudflared quick tunnel rotates and the launcher respawns the API with a
// NEW KORTIX_URL; every running box keeps calling the dead URL until its next
// prompt's env sync rewrites it, so the first prompt after a rotation fails
// inside OpenCode with `Cannot connect to API`. `convergeActiveSandboxGatewayUrl`
// re-pushes the live gateway URL to the boxes this instance provisioned whose
// stamped `metadata.kortixUrl` differs from the current `config.KORTIX_URL`.
//
// Same `mock.module` + `globalThis.fetch` pattern as the sibling
// `sandbox-env-sync.instance-scope.test.ts` (runs isolated per file).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import * as realEnvSync from './sandbox-env-sync';

const dialect = new PgDialect();

type SandboxRow = {
  sandboxId: string;
  externalId: string | null;
  sessionId: string;
  projectId: string;
  provider: string;
  status: string;
  config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};
let sandboxRows: SandboxRow[] = [];
let updateCalls: Array<{ set: Record<string, unknown> }> = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // The selector filters `status = 'active'` in SQL; mirror that here so
          // a stopped row proves the WHERE, not the in-memory filter.
          const rows = sandboxRows.filter((r) => r.status === 'active');
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateCalls.push({ set: values });
        return { where: async () => undefined };
      },
    }),
  },
}));
mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async (externalId: string) => ({
    url: `https://daemon.test/${externalId}`,
    headers: { 'x-ingress': externalId },
  }),
}));
/** External ids the DB-backed service-key lookup was asked for. */
let serviceKeyLookups: string[] = [];
mock.module('../../platform/service-key', () => ({
  serviceKeyForExternalId: async (externalId: string) => {
    serviceKeyLookups.push(externalId);
    return externalId === 'no-key-anywhere' ? undefined : `db-svc-${externalId}`;
  },
}));

/** Session ids whose project env snapshot resolves (everything else → null → empty snapshot). */
let sessionsWithSnapshot = new Set<string>();
mock.module('./sandbox-env-sync', () => ({
  ...realEnvSync,
  resolveSandboxEnvSnapshot: async (_projectId: string, sessionId: string | null) =>
    sessionId && sessionsWithSnapshot.has(sessionId)
      ? {
          env: { EXAMPLE: 'v1' },
          names: ['EXAMPLE'],
          revision: 'rev-1',
          scope: 'inherit' as const,
          capabilitiesJson: '{"version":1,"capabilities":[]}',
        }
      : null,
}));

/** Every env push the fake daemons received, in order. */
let pushes: Array<{ externalId: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
/** External ids whose daemon answers 500. */
let failingBoxes = new Set<string>();
const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (
  url: unknown,
  init?: { body?: string; headers?: Record<string, string> },
) => {
  const href = String(url);
  const externalId = new URL(href).pathname.split('/')[1]!;
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  pushes.push({ externalId, headers: init?.headers ?? {}, body });
  if (failingBoxes.has(externalId)) return new Response('boom', { status: 500 });
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: Object.keys((body.env as Record<string, unknown>) ?? {}).length,
    managed: 0,
    withheld: 0,
    agent_env_written: true,
    opencode: 'starting',
    opencode_reload: 'restarted',
  });
};

const { convergeActiveSandboxGatewayUrl } = await import('./gateway-url-convergence');
const { llmGatewayBaseUrlForProvider } = await import('./sandbox-env-sync');
const { config } = await import('../../config');

const CURRENT_URL = 'https://live-tunnel.trycloudflare.com';
const DEAD_URL = 'https://dead-tunnel.trycloudflare.com';
const ORIGINAL_KORTIX_URL = config.KORTIX_URL;
const ORIGINAL_INSTANCE = (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID;
const setInstance = (value: string | undefined) => {
  (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID = value;
};
const setKortixUrl = (value: string | undefined) => {
  (config as { KORTIX_URL: string | undefined }).KORTIX_URL = value;
};

function row(
  externalId: string,
  metadata: Record<string, unknown> | null,
  overrides: Partial<SandboxRow> = {},
): SandboxRow {
  return {
    sandboxId: `sb-${externalId}`,
    externalId,
    sessionId: `sess-${externalId}`,
    projectId: 'proj-1',
    provider: 'daytona',
    status: 'active',
    config: { serviceKey: `svc-${externalId}` },
    metadata,
    ...overrides,
  };
}

const warnings: string[] = [];
const ORIGINAL_WARN = console.warn;
const ORIGINAL_LOG = console.log;
const logs: string[] = [];

beforeEach(() => {
  sandboxRows = [];
  updateCalls = [];
  pushes = [];
  failingBoxes = new Set();
  serviceKeyLookups = [];
  sessionsWithSnapshot = new Set();
  warnings.length = 0;
  logs.length = 0;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  setKortixUrl(CURRENT_URL);
  setInstance(undefined);
});
afterEach(() => {
  console.warn = ORIGINAL_WARN;
  console.log = ORIGINAL_LOG;
  setKortixUrl(ORIGINAL_KORTIX_URL);
  setInstance(ORIGINAL_INSTANCE);
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('convergeActiveSandboxGatewayUrl — the selector', () => {
  test('same url → skip; different url → converge; no stamp (legacy) → skip; stopped → skip', async () => {
    sandboxRows = [
      row('same', { kortixUrl: CURRENT_URL }),
      row('stale', { kortixUrl: DEAD_URL }),
      row('legacy', {}),
      row('legacy-null-meta', null),
      row('stopped', { kortixUrl: DEAD_URL }, { status: 'stopped' }),
    ];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'test' });
    expect(report).toEqual({ candidates: 1, converged: 1, failed: 0 });
    expect(pushes.map((p) => p.externalId)).toEqual(['stale']);
  });

  test('a box another local instance provisioned is never touched (instance scope)', async () => {
    setInstance('wt-a');
    sandboxRows = [
      row('mine', { kortixUrl: DEAD_URL, instanceId: 'wt-a' }),
      row('theirs', { kortixUrl: DEAD_URL, instanceId: 'wt-b' }),
      row('legacy-unstamped-instance', { kortixUrl: DEAD_URL }),
    ];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'test' });
    expect(pushes.map((p) => p.externalId).sort()).toEqual(['legacy-unstamped-instance', 'mine']);
    expect(report).toEqual({ candidates: 2, converged: 2, failed: 0 });
  });

  test('deployed environments: every row carries the stable KORTIX_URL → 0 candidates, no push, no DB write', async () => {
    sandboxRows = [
      row('p1', { kortixUrl: CURRENT_URL }),
      row('p2', { kortixUrl: CURRENT_URL }),
      row('p3', { kortixUrl: CURRENT_URL }),
    ];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'boot' });
    expect(report).toEqual({ candidates: 0, converged: 0, failed: 0 });
    expect(pushes).toEqual([]);
    expect(updateCalls).toEqual([]);
  });

  test('KORTIX_URL unset → no-op (nothing selected, nothing pushed)', async () => {
    setKortixUrl(undefined);
    sandboxRows = [row('stale', { kortixUrl: DEAD_URL })];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'boot' });
    expect(report).toEqual({ candidates: 0, converged: 0, failed: 0 });
    expect(pushes).toEqual([]);
  });

  test('a row without an external id is not a candidate', async () => {
    sandboxRows = [row('no-ext', { kortixUrl: DEAD_URL }, { externalId: null })];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'test' });
    expect(report).toEqual({ candidates: 0, converged: 0, failed: 0 });
  });
});

describe('convergeActiveSandboxGatewayUrl — the push', () => {
  test('posts the SAME /kortix/env push the per-prompt path uses: gateway on, base url for the row provider, refreshModels true, empty snapshot when the project has none', async () => {
    sandboxRows = [row('stale', { kortixUrl: DEAD_URL }, { provider: 'e2b' })];
    await convergeActiveSandboxGatewayUrl({ reason: 'test' });

    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.headers.Authorization).toBe('Bearer svc-stale');
    expect(push.headers['x-ingress']).toBe('stale');
    expect(push.body.llmGatewayEnabled).toBe(true);
    expect(push.body.llmGatewayBaseUrl).toBe(llmGatewayBaseUrlForProvider('e2b'));
    expect(String(push.body.llmGatewayBaseUrl).startsWith(CURRENT_URL)).toBe(true);
    expect(push.body.refreshModels).toBe(true);
    // No project env for this session → the empty snapshot, not a skipped push.
    expect(push.body.env).toEqual({});
    expect(push.body.names).toEqual([]);
    expect(String(push.body.revision).startsWith('gateway-url-convergence-')).toBe(true);
  });

  test('uses the project env snapshot when the session has one', async () => {
    sessionsWithSnapshot = new Set(['sess-stale']);
    sandboxRows = [row('stale', { kortixUrl: DEAD_URL })];
    await convergeActiveSandboxGatewayUrl({ reason: 'test' });
    expect(pushes[0]!.body.env).toEqual({ EXAMPLE: 'v1' });
    expect(pushes[0]!.body.names).toEqual(['EXAMPLE']);
    expect(pushes[0]!.body.revision).toBe('rev-1');
  });

  test('on success the row is re-stamped with the current KORTIX_URL', async () => {
    sandboxRows = [row('stale', { kortixUrl: DEAD_URL })];
    await convergeActiveSandboxGatewayUrl({ reason: 'test' });
    expect(updateCalls).toHaveLength(1);
    // The metadata write is a jsonb merge (`coalesce(metadata,'{}') || '{...}'`);
    // the stamp travels as a JSON param on that SQL.
    const merged = dialect.sqlToQuery(
      updateCalls[0]!.set.metadata as Parameters<typeof dialect.sqlToQuery>[0],
    );
    expect(merged.sql).toContain('||');
    expect(merged.params).toContain(JSON.stringify({ kortixUrl: CURRENT_URL }));
  });

  test('falls back to the DB service-key lookup when the row config has no serviceKey', async () => {
    sandboxRows = [row('stale', { kortixUrl: DEAD_URL }, { config: {} })];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'test' });
    expect(serviceKeyLookups).toEqual(['stale']);
    expect(pushes[0]!.headers.Authorization).toBe('Bearer db-svc-stale');
    expect(report).toEqual({ candidates: 1, converged: 1, failed: 0 });
  });
});

describe('convergeActiveSandboxGatewayUrl — fail-soft', () => {
  test('one box failing does not stop the others; the failed row keeps its stale stamp; one summary line', async () => {
    failingBoxes = new Set(['bad']);
    sandboxRows = [
      row('a', { kortixUrl: DEAD_URL }),
      row('bad', { kortixUrl: DEAD_URL }),
      row('b', { kortixUrl: DEAD_URL }),
      row('no-key-anywhere', { kortixUrl: DEAD_URL }, { config: {} }),
    ];
    const report = await convergeActiveSandboxGatewayUrl({ reason: 'boot' });
    expect(report).toEqual({ candidates: 4, converged: 2, failed: 2 });
    expect(pushes.map((p) => p.externalId).sort()).toEqual(['a', 'b', 'bad']);
    // Only the converged rows are re-stamped.
    expect(updateCalls).toHaveLength(2);
    expect(warnings.some((w) => w.includes('bad'))).toBe(true);
    expect(warnings.some((w) => w.includes('no-key-anywhere'))).toBe(true);
    const summary = logs.filter(
      (l) => l.includes('[gateway-url-convergence]') && l.includes('candidates='),
    );
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('reason=boot');
    expect(summary[0]).toContain('candidates=4');
    expect(summary[0]).toContain('converged=2');
    expect(summary[0]).toContain('failed=2');
  });

  test('a DB failure on the select is swallowed into a warning and an empty report (boot never dies on it)', async () => {
    const { db } = await import('../../shared/db');
    const originalSelect = (db as { select: unknown }).select;
    (db as { select: unknown }).select = () => {
      throw new Error('db down');
    };
    try {
      const report = await convergeActiveSandboxGatewayUrl({ reason: 'boot' });
      expect(report).toEqual({ candidates: 0, converged: 0, failed: 0 });
      expect(warnings.some((w) => w.includes('db down'))).toBe(true);
    } finally {
      (db as { select: unknown }).select = originalSelect;
    }
  });
});
