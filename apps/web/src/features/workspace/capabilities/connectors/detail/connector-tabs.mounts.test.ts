import type { AdminConnector } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CONNECTOR_TABS, CONNECTOR_TAB_LABEL_KEY, type ConnectorTab } from './connector-tabs';

const win = new Window();
const globals = globalThis as Record<string, unknown>;
for (const key of [
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'HTMLInputElement',
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  globals[key] = key === 'window' ? win : Reflect.get(win, key);
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const connector = {
  slug: 'mount-fixture',
  name: 'Mount fixture',
  provider: 'mcp',
  status: 'active',
  actions: [],
  credentialMode: 'shared',
  authorizationStrategy: 'project',
  sensitive: false,
  secretSet: true,
} as AdminConnector;
let search = new URLSearchParams();
const router = {
  replace: (url: string) => {
    search = new URLSearchParams(url.split('?')[1]);
  },
  push: () => {},
};
mock.module('next/navigation', () => ({
  useSearchParams: () => search,
  useRouter: () => router,
  usePathname: () => '/connector',
}));
// External data, permissions and connection dialogs are boundaries. The two
// shells, shared tab switch, Radix tabs and all four tab bodies stay real.
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listConnectors: async () => ({ connectors: [connector] }),
  getProjectDetail: async () => ({ project: { name: 'Fixture project' } }),
  getConnectorPolicies: async () => ({ policies: [], effective: [] }),
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useProjectAccountId: () => 'fixture-account',
  useProjectTriggerEventApps: () => ({
    data: {
      apps: [{ slug: 'fixture-app', name: 'Fixture app', connector: connector.slug, events: [] }],
    },
  }),
  useProjectTriggers: () => ({ data: { triggers: [] }, isLoading: false, isError: false }),
}));
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: true, isLoading: false }),
}));
mock.module('@/lib/use-project-feature-flags', () => ({
  useProjectFeatureFlags: () => ({ flags: { event_triggers: true } }),
}));
mock.module('@/hooks/connectors/use-oauth2-return', () => ({ useOauth2Return: () => {} }));
mock.module('./use-connector-detail', () => ({
  useConnectorDetail: () => ({
    displayName: connector.name,
    isManagedProvider: false,
    isChannel: false,
    isComputer: false,
    connectionsQuery: {
      isSuccess: true,
      isError: false,
      isFetching: false,
      refetch: async () => ({}),
    },
    accounts: [],
    connected: true,
    canManageConnections: true,
    headerCta: 'none',
    connectPending: false,
    refreshAccounts: () => {},
    replaceSoleAccount: () => {},
    startPrivateSession: () => {},
    reconnectAccount: () => {},
    credentialTarget: null,
    setCredentialTarget: () => {},
    computerOpen: false,
    setComputerOpen: () => {},
  }),
}));
mock.module('@/features/workspace/customize/sections/connectors-view', () => ({
  ConnectionsList: () => createElement('p', null, 'Fixture account roster'),
  ConnectionSection: () => createElement('p', null, 'Fixture transport configuration'),
  ConnectionRoster: () => null,
  ChannelConnectionSection: () => null,
  SetCredentialModal: () => null,
}));
mock.module('@/features/tunnel/computer-connect', () => ({ ComputerConnectModal: () => null }));
mock.module('@/components/projects/schedule/trigger-composer', () => ({
  TriggerComposer: () => null,
}));
mock.module('@/components/projects/schedule/trigger-controls', () => ({
  useTriggerControls: () => ({ canCreate: false }),
}));
mock.module('@/components/projects/schedule/use-event-titles', () => ({
  useEventTitles: () => new Map(),
}));

const { ConnectorModal } = await import('./connector-modal');
const { ConnectorPage } = await import('./connector-page');
const { useTranslations } = await import('@/i18n/use-translations');
const roots: Root[] = [];
const clients: QueryClient[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const client of clients.splice(0)) client.clear();
  win.document.body.innerHTML = '';
});

// Copy comes from the real English catalog rather than a source-text scan.
function Labels() {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return createElement(
    'span',
    { 'data-labels': true },
    JSON.stringify(
      Object.fromEntries(CONNECTOR_TABS.map((tab) => [tab, t.raw(CONNECTOR_TAB_LABEL_KEY[tab])])),
    ),
  );
}
const BODY: Record<ConnectorTab, string> = {
  accounts: 'Fixture account roster',
  tools: 'No tools',
  triggers: 'No trigger starts an agent from Mount fixture events yet.',
  settings: 'Fixture transport configuration',
};
for (const shell of ['modal', 'page'] as const) {
  describe(`${shell} executes every selected connector tab`, () => {
    test('each selection renders its real body and not the previous tab', async () => {
      search = new URLSearchParams();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      clients.push(client);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      roots.push(root);
      const render = () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(Labels),
            shell === 'modal'
              ? createElement(ConnectorModal, {
                  projectId: 'fixture-project',
                  connector,
                  canWrite: true,
                  open: true,
                  onOpenChange: () => {},
                  onChanged: () => {},
                  onRemoved: () => {},
                })
              : createElement(ConnectorPage, {
                  projectId: 'fixture-project',
                  appSegment: 'connected',
                  connectorSlug: connector.slug,
                }),
          ),
        );
      await act(async () => {
        render();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      // Query notifications may land after the initial render's effects.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const labels: Record<ConnectorTab, string> = JSON.parse(
        host.querySelector('[data-labels]')?.textContent ?? '{}',
      );
      for (const tab of CONNECTOR_TABS) {
        const trigger = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) =>
          node.textContent?.startsWith(labels[tab]),
        );
        expect(trigger).toBeDefined();
        await act(async () => {
          trigger?.dispatchEvent(
            new win.MouseEvent('mousedown', { bubbles: true, button: 0 }) as MouseEvent,
          );
          trigger?.click();
        });
        if (shell === 'page')
          await act(async () => {
            render();
          });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(trigger?.getAttribute('aria-selected')).toBe('true');
        const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(
          (panel) => panel.getAttribute('data-state') === 'active',
        );
        expect(panels).toHaveLength(1);
        expect(panels[0]?.textContent).toContain(BODY[tab]);
        for (const other of CONNECTOR_TABS.filter((value) => value !== tab)) {
          expect(panels[0]?.textContent).not.toContain(BODY[other]);
        }
      }
    });
  });
}
