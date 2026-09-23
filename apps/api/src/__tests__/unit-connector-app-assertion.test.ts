/**
 * Connector → Kortix App (spec docs/specs/2026-09-22-agents-as-principals.md
 * §2.5). The incident: a connector built from an App's OpenAPI document put the
 * App's OWN key in `Authorization`; the App gate read it as a Kortix credential
 * and answered `401 app_auth_required`. The gateway now adds a short-lived
 * signed assertion for the calling session in `X-Kortix-App-Authorization` —
 * only for openapi/http connectors, only for an agent session, and only when
 * `appAuthorizationFor` recognises the base URL as an App of the same project.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CallInput,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  handleCall,
} from '../connectors/gateway';
import { executeCall } from '../connectors/call';

const APP_BASE = 'https://dev-dashboards-cccccccccccccccc.apps.kortix.com';

const APP_CONNECTOR: GatewayConnector = {
  connectorId: 'conn-dash',
  slug: 'reports-dashboard-api',
  provider: 'openapi',
  baseUrl: APP_BASE,
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const LIST: GatewayAction = {
  path: 'reports-dashboard-api.reports.list',
  relPath: 'reports.list',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  binding: { kind: 'openapi', method: 'GET', path: '/api/reports', server: APP_BASE },
};

function deps(o: {
  connector?: GatewayConnector;
  action?: GatewayAction;
  appAuthorizationFor?: GatewayDeps['appAuthorizationFor'];
}) {
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  const d: GatewayDeps = {
    loadConnectorBySlug: async () => o.connector ?? APP_CONNECTOR,
    loadAction: async () => o.action ?? LIST,
    resolveCredential: async () => 'app-own-write-key',
    loadPolicies: async () => [],
    recordExecution: async () => null,
    appAuthorizationFor: o.appAuthorizationFor,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, headers: init.headers });
      return { status: 200, ok: true, text: async () => '{"ok":true}' };
    },
  };
  return { d, fetchCalls };
}

const input: CallInput = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: 'user-1', groupIds: [] },
  sessionId: 'sess-1',
  actingTokenId: 'tok-1',
  connectorSlug: 'reports-dashboard-api',
  actionPath: 'reports.list',
};

const headerOf = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('handleCall attaches the App assertion', () => {
  test('same-project App: the assertion rides in X-Kortix-App-Authorization, the App key stays in Authorization', async () => {
    const asked: unknown[] = [];
    const { d, fetchCalls } = deps({
      appAuthorizationFor: async (q) => {
        asked.push(q);
        return 'Bearer kortix_app_assertion.body.mac';
      },
    });
    const res = await handleCall(d, input);
    expect(res.status).toBe('ok');
    expect(asked).toEqual([{ projectId: 'proj-1', baseUrl: APP_BASE, sessionId: 'sess-1', tokenId: 'tok-1' }]);
    expect(headerOf(fetchCalls[0]!.headers, 'x-kortix-app-authorization')).toBe('Bearer kortix_app_assertion.body.mac');
    expect(headerOf(fetchCalls[0]!.headers, 'authorization')).toBe('Bearer app-own-write-key');
  });

  test('a foreign host (the resolver answers null) gets no assertion', async () => {
    const { d, fetchCalls } = deps({ appAuthorizationFor: async () => null });
    await handleCall(d, input);
    expect(headerOf(fetchCalls[0]!.headers, 'x-kortix-app-authorization')).toBeUndefined();
  });

  test('a caller that is not an agent session (no session or no token) is never asked about', async () => {
    let asked = 0;
    const resolver = async () => {
      asked += 1;
      return 'Bearer x';
    };
    for (const variant of [{ sessionId: null }, { actingTokenId: null }]) {
      const { d, fetchCalls } = deps({ appAuthorizationFor: resolver });
      await handleCall(d, { ...input, ...variant });
      expect(headerOf(fetchCalls[0]!.headers, 'x-kortix-app-authorization')).toBeUndefined();
    }
    expect(asked).toBe(0);
  });

  test('an http connector gets it too; the base URL is the connector base_url', async () => {
    const asked: Array<{ baseUrl: string }> = [];
    const { d, fetchCalls } = deps({
      connector: { ...APP_CONNECTOR, provider: 'http' },
      action: { ...LIST, binding: { kind: 'http', method: 'GET', path: '/api/reports' } },
      appAuthorizationFor: async (q) => {
        asked.push(q);
        return 'Bearer a';
      },
    });
    await handleCall(d, input);
    expect(asked[0]!.baseUrl).toBe(APP_BASE);
    expect(headerOf(fetchCalls[0]!.headers, 'x-kortix-app-authorization')).toBe('Bearer a');
  });

  test('an MCP connector is never asked about (openapi/http only)', async () => {
    let asked = 0;
    const { d } = deps({
      connector: { ...APP_CONNECTOR, provider: 'mcp' },
      action: { ...LIST, binding: { kind: 'mcp', tool: 'reports' } },
      appAuthorizationFor: async () => {
        asked += 1;
        return 'Bearer a';
      },
    });
    await handleCall(d, input).catch(() => undefined);
    expect(asked).toBe(0);
  });

  test('a resolver failure never fails the call; the request goes out without an assertion', async () => {
    const { d, fetchCalls } = deps({
      appAuthorizationFor: async () => {
        throw new Error('db down');
      },
    });
    const res = await handleCall(d, input);
    expect(res.status).toBe('ok');
    expect(headerOf(fetchCalls[0]!.headers, 'x-kortix-app-authorization')).toBeUndefined();
  });
});

describe('executeCall carries appAuthorization only on openapi/http', () => {
  test('openapi: set, and a static connector header cannot pre-empt it', async () => {
    const seen: Record<string, string>[] = [];
    await executeCall({
      binding: LIST.binding,
      baseUrl: APP_BASE,
      headers: { 'X-Kortix-App-Authorization': 'Bearer static' },
      appAuthorization: 'Bearer minted',
      fetchImpl: async (_url, init) => {
        seen.push(init.headers);
        return { status: 200, ok: true, text: async () => '{}' };
      },
    });
    const values = Object.entries(seen[0]!).filter(([k]) => k.toLowerCase() === 'x-kortix-app-authorization');
    expect(values).toEqual([['X-Kortix-App-Authorization', 'Bearer minted']]);
  });
});
