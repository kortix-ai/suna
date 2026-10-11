import { beforeEach, describe, expect, mock, test } from 'bun:test';

// `useQuery` mocked to identity (same harness as `./use-project-triggers.test.ts`),
// so the hook runs as a plain function and its config is asserted directly.
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useConnectorQuery } = await import('./use-connector-query');
const { qk } = await import('./query-keys');
const { configureKortix } = await import('../core/http/config');
const { ConnectorCallError } = await import('../core/rest/projects-client/connector-run');

let bodies: any[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  bodies = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

function connectorError(status: number, retryAfterSeconds: number | null = null) {
  return new ConnectorCallError('x', {
    status,
    reason: 'x',
    connector: 'crm',
    action: 'list',
    retryAfterSeconds,
  });
}

describe('useConnectorQuery', () => {
  test('keys the call by project, connector, action, account and args under the connector config key', () => {
    const config = useConnectorQuery('p1', 'crm', 'list', { limit: 5 }, { account: 'me' }) as any;
    expect(config.queryKey).toEqual(qk.project.connectorCall('p1', 'crm', 'list', { limit: 5 }, 'me'));
    expect(config.queryKey.slice(0, qk.project.connectorConfig('p1', 'crm').length)).toEqual([
      ...qk.project.connectorConfig('p1', 'crm'),
    ]);
    const other = useConnectorQuery('p1', 'crm', 'list', { limit: 6 }) as any;
    expect(other.queryKey).not.toEqual(config.queryKey);
  });

  test('is disabled without a project id or with enabled: false', () => {
    expect((useConnectorQuery(undefined, 'crm', 'list', {}) as any).enabled).toBe(false);
    expect((useConnectorQuery('p1', 'crm', 'list', {}, { enabled: false }) as any).enabled).toBe(false);
    expect((useConnectorQuery('p1', 'crm', 'list', {}) as any).enabled).toBe(true);
  });

  test('caches for 30 s by default and never refetches on window focus', () => {
    const config = useConnectorQuery('p1', 'crm', 'list', {}) as any;
    expect(config.staleTime).toBe(30_000);
    expect(config.refetchOnWindowFocus).toBe(false);
    expect((useConnectorQuery('p1', 'crm', 'list', {}, { staleTime: 5_000 }) as any).staleTime).toBe(5_000);
  });

  test('queryFn runs the action and resolves its output', async () => {
    reply = { status: 200, body: { ok: true, data: { rows: [1] }, binding: 'openapi', upstream_status: 200 } };
    const config = useConnectorQuery('p1', 'crm', 'list', { limit: 5 }, { account: 'me' }) as any;
    const output = await config.queryFn({ signal: new AbortController().signal });
    expect(output).toEqual({ rows: [1] });
    expect(bodies[0]).toEqual({ connector: 'crm', action: 'list', args: { limit: 5 }, account: 'me' });
  });

  test('queryFn rejects with ConnectorCallError carrying connectUrl', async () => {
    reply = {
      status: 403,
      body: { ok: false, status: 'denied', reason: 'connector_not_connected', connect_url: 'https://app.test/c/1' },
    };
    const config = useConnectorQuery('p1', 'crm', 'list', {}) as any;
    const error = await config.queryFn({ signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error.connectUrl).toBe('https://app.test/c/1');
  });

  test('retries only an upstream 429 or 503, at most twice, after Retry-After', () => {
    const config = useConnectorQuery('p1', 'crm', 'list', {}) as any;
    expect(config.retry(0, connectorError(403))).toBe(false);
    expect(config.retry(0, connectorError(500))).toBe(false);
    expect(config.retry(0, new Error('network'))).toBe(false);
    expect(config.retry(0, connectorError(429))).toBe(true);
    expect(config.retry(1, connectorError(503))).toBe(true);
    expect(config.retry(2, connectorError(429))).toBe(false);
    expect(config.retryDelay(0, connectorError(429, 3))).toBe(3_000);
    expect(config.retryDelay(0, connectorError(429, 600))).toBe(30_000);
    expect(config.retryDelay(1, connectorError(429))).toBe(2_000);
  });
});
