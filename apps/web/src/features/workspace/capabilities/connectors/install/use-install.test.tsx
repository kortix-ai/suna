import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const sdk = await import('@kortix/sdk');
let syncError: string | null = null;
mock.module('@kortix/sdk', () => ({
  ...sdk,
  createConnector: async (_projectId: string, draft: { slug: string }) => ({
    sync: { synced: 1, errors: syncError ? [{ slug: draft.slug, error: syncError }] : [] },
  }),
}));
const pushed: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (url: string) => pushed.push(url) }),
}));
const toasts: Array<[string, string]> = [];
mock.module('@/components/ui/toast', () => ({
  successToast: (message: string) => toasts.push(['success', message]),
  warningToast: (message: string) => toasts.push(['warning', message]),
  errorToast: (message: string) => toasts.push(['error', message]),
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

const { discoverInstallTarget } = await import('./install');
const { useInstall } = await import('./use-install');

const linear = discoverInstallTarget('Linear', {
  id: 'linear-mcp',
  kind: 'mcp',
  name: 'Linear MCP server',
  template: { provider: 'mcp', url: 'https://mcp.example.com' },
});

/** Install Linear once and return where the page went. */
async function installOnce(): Promise<string> {
  let install: ReturnType<typeof useInstall>['install'] | null = null;
  function Probe() {
    install = useInstall('synthetic-project').install;
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => {
    install!(linear, { connectors: [], app: null });
    // runInstall, the refetch and the navigation each take a microtask turn.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  expect(pushed).toHaveLength(1);
  return pushed[0]!;
}

beforeEach(() => {
  pushed.length = 0;
  toasts.length = 0;
  syncError = null;
});

describe('useInstall lands on the connector page', () => {
  test('a clean install opens Add account', async () => {
    const url = await installOnce();
    expect(url).toMatch(/\/customize\/connectors\/connected\/linear-[a-z0-9]{6}\?add=1$/);
    expect(toasts).toEqual([['success', 'installed']]);
  });

  test('an MCP server that asks for sign-in (401) opens Add account', async () => {
    syncError = 'MCP tools/list failed: HTTP 401';
    const url = await installOnce();
    expect(url).toEndWith('?add=1');
    expect(toasts).toEqual([['success', 'installed']]);
  });

  test('any other sync failure opens the page with Retry, never a dead end', async () => {
    syncError = 'connect ECONNREFUSED';
    const url = await installOnce();
    expect(url).toMatch(/\/customize\/connectors\/connected\/linear-[a-z0-9]{6}$/);
    expect(toasts).toEqual([['warning', 'installedSyncFailed']]);
  });
});
