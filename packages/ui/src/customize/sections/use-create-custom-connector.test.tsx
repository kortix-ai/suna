import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { ConnectorDraftInput } from '@kortix/sdk';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const sdk = await import('@kortix/sdk');
type Sync = { synced: number; errors: Array<{ slug: string; error: string }> };
const BEARER = { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' } as const;
// What the server answers: the create's first sync, its auth discovery, and
// the re-sync a credential write runs.
let created: { sync?: Sync; authDiscovery?: { recommended: typeof BEARER | null } } = {};
let createFails: Error | null = null;
let resync: Sync | undefined;
const sdkCalls: string[] = [];
mock.module('@kortix/sdk', () => ({
  ...sdk,
  createConnector: async () => {
    sdkCalls.push('create');
    if (createFails) throw createFails;
    return { ok: true, ...created };
  },
  setConnectorCredential: async () => {
    sdkCalls.push('credential');
    return { ok: true, ...(resync ? { sync: resync } : {}) };
  },
  deleteConnector: async () => {
    sdkCalls.push('delete');
    return { ok: true };
  },
}));
const toasts: Array<[string, string]> = [];
const uiToastMock = () => ({
  successToast: (message: string) => toasts.push(['success', message]),
  warningToast: (message: string) => toasts.push(['warning', message]),
  errorToast: (message: string) => toasts.push(['error', message]),
});
mock.module('../../primitives/toast', uiToastMock);
mock.module('../../primitives/toast', uiToastMock);
mock.module('../../i18n', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

const { useCreateCustomConnector } = await import('./use-create-custom-connector');
const { EMPTY_OAUTH2_CREDENTIAL_FORM } = await import('./connector-oauth2');

const mcp: ConnectorDraftInput = {
  slug: 'vendor-mcp',
  provider: 'mcp',
  url: 'https://mcp.example.com',
};
const fails = (error: string): Sync => ({ synced: 1, errors: [{ slug: 'vendor-mcp', error }] });
const OAUTH2 = {
  ...EMPTY_OAUTH2_CREDENTIAL_FORM,
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
};

/** Submit the custom form's save once; return what `onAdded` received. */
async function saveOnce(
  draft: ConnectorDraftInput,
  oauth2: typeof OAUTH2 | null = null,
): Promise<Array<[string, { addAccount: boolean }]>> {
  const added: Array<[string, { addAccount: boolean }]> = [];
  let save: ReturnType<typeof useCreateCustomConnector> | null = null;
  function Probe() {
    save = useCreateCustomConnector('synthetic-project', (slug, options) =>
      added.push([slug, options]),
    );
    return null;
  }
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => {
    await save!.mutateAsync({ draft, oauth2 }).catch(() => undefined);
  });
  return added;
}

beforeEach(() => {
  created = {};
  createFails = null;
  resync = undefined;
  sdkCalls.length = 0;
  toasts.length = 0;
});

describe('the custom connector form hands off to the connector page', () => {
  test('a clean sync opens the page, no Add account', async () => {
    created = { sync: { synced: 1, errors: [] } };
    expect(await saveOnce(mcp)).toEqual([['vendor-mcp', { addAccount: false }]]);
    expect(toasts).toEqual([['success', 'i18nComplete.text29f396e2d238']]);
  });

  test('an MCP 401 on a connector with an auth scheme opens Add account', async () => {
    created = {
      sync: fails('MCP tools/list failed: HTTP 401'),
      authDiscovery: { recommended: BEARER },
    };
    expect(await saveOnce(mcp)).toEqual([['vendor-mcp', { addAccount: true }]]);
    expect(toasts).toEqual([['success', 'i18nComplete.text29f396e2d238']]);
  });

  test('an MCP 401 with no auth scheme opens the page with the failure, not Add account', async () => {
    created = {
      sync: fails('MCP tools/list failed: HTTP 401'),
      authDiscovery: { recommended: null },
    };
    expect(await saveOnce(mcp)).toEqual([['vendor-mcp', { addAccount: false }]]);
    expect(toasts).toEqual([['warning', 'installedSyncFailed']]);
  });

  test('any other sync failure opens the page with the failure', async () => {
    created = { sync: fails('connect ECONNREFUSED') };
    expect(await saveOnce(mcp)).toEqual([['vendor-mcp', { addAccount: false }]]);
    expect(toasts).toEqual([['warning', 'installedSyncFailed']]);
  });

  test('a stored OAuth2 credential whose re-sync loads the tools reads connected', async () => {
    created = {
      sync: fails('MCP tools/list failed: HTTP 401'),
      authDiscovery: { recommended: BEARER },
    };
    resync = { synced: 1, errors: [] };
    const added = await saveOnce({ ...mcp, auth: { type: 'bearer' } }, OAUTH2);
    expect(added).toEqual([['vendor-mcp', { addAccount: false }]]);
    expect(sdkCalls).toEqual(['create', 'credential']);
    expect(toasts).toEqual([['success', 'i18nComplete.text5120ee26cbf5']]);
  });

  test('a stored OAuth2 credential the server still refuses is a failure, never connected', async () => {
    created = {
      sync: fails('MCP tools/list failed: HTTP 401'),
      authDiscovery: { recommended: BEARER },
    };
    resync = fails('MCP tools/list failed: HTTP 401');
    const added = await saveOnce({ ...mcp, auth: { type: 'bearer' } }, OAUTH2);
    expect(added).toEqual([['vendor-mcp', { addAccount: false }]]);
    expect(toasts).toEqual([['warning', 'installedSyncFailed']]);
  });

  test('a rejected create keeps the form open', async () => {
    createFails = new Error('Connector already exists');
    expect(await saveOnce(mcp)).toEqual([]);
    expect(toasts).toEqual([['error', 'Connector already exists']]);
  });
});
