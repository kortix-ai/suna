const sdk = await import('@kortix/sdk');
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let flag = true;
let configured = true;
let search = new URLSearchParams();
const replacements: string[] = [];
const requests: string[] = [];
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listConnectors: async () => ({ connectors: [] }),
  getProjectDetail: async () => ({ project_id: 'synthetic' }),
  getConnectStatus: async () => ({ configured, providers: configured ? ['composio'] : [] }),
  listConnectToolkits: async () => {
    requests.push('managed');
    return { toolkits: [], total: 0, hasMore: false };
  },
  listConnectSections: async () => {
    requests.push('managed-sections');
    return { popular: [], sections: [], categories: [] };
  },
  listDiscoverConnectors: async () => {
    requests.push('direct');
    return { items: [], total: 0, hasMore: false };
  },
  listDiscoverSections: async () => {
    requests.push('direct-sections');
    return { popular: [], sections: [], categories: [] };
  },
}));
const reactSdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...reactSdk,
  useFeatureFlag: () => ({ enabled: flag }),
  useProjectAccountId: () => 'synthetic',
}));
mock.module('next/navigation', () => ({
  useSearchParams: () => search,
  usePathname: () => '/projects/synthetic/connectors',
  useRouter: () => ({
    replace: (url: string) => {
      replacements.push(url);
      search = new URLSearchParams(url.split('?')[1]);
    },
  }),
}));
mock.module('next/dynamic', () => ({ default: () => () => null }));
mock.module('@/lib/use-project-can', () => ({ useProjectCan: () => ({ allowed: false }) }));
mock.module('@/hooks/tunnel/use-tunnel', () => ({
  useTunnelConnections: () => ({ isSuccess: false }),
}));
mock.module('@/features/workspace/customize/use-configure-thread', () => ({
  useConfigureThread: () => ({}),
  newConfigPrompt: () => '',
}));
mock.module('@/features/workspace/customize/sections/connector-connection-form', () => ({
  connectorConnectionQueryKeys: () => [],
  connectorSetupStatus: () => 'connected',
}));
for (const [path, name] of [
  ['@/components/projects/policies-panel', 'PoliciesPanel'],
  ['@/features/tunnel/computer-connect', 'ComputerConnectModal'],
  ['@/features/workspace/capabilities/connectors/add/discover-add-flow', 'DiscoverAddFlow'],
  ['@/features/workspace/capabilities/connectors/add/easy-connect-add-flow', 'EasyConnectAddFlow'],
])
  mock.module(path, () => ({ [name]: () => null }));
const wrapper = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
for (const [path, names] of [
  [
    '@/components/ui/modal',
    ['Modal', 'ModalBody', 'ModalContent', 'ModalDescription', 'ModalHeader', 'ModalTitle'],
  ],
  [
    '@/components/ui/sheet',
    ['Sheet', 'SheetBody', 'SheetContent', 'SheetDescription', 'SheetHeader', 'SheetTitle'],
  ],
] as const)
  mock.module(path, () => Object.fromEntries(names.map((name) => [name, wrapper])));
mock.module('@/features/workspace/capabilities/shared/capability-page-shell', () => ({
  CapabilityPageShell: ({ filters, children }: { filters: ReactNode; children: ReactNode }) =>
    createElement('main', null, filters, children),
}));
mock.module('@/features/workspace/capabilities/connectors/catalog/connector-browse', () => ({
  ConnectorBrowse: ({ state }: { state: { source: string } }) =>
    createElement('output', null, state.source),
}));
// Keep both ConnectorsPage and useCatalog real: only network and presentation boundaries are substituted.
const { ConnectorsPage } = await import('./connectors-page');

async function mount(params = '', enabled = true, provider = true) {
  flag = enabled;
  configured = provider;
  search = new URLSearchParams(params);
  replacements.length = 0;
  requests.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(ConnectorsPage, { projectId: 'synthetic' }),
    );
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(element());
  });
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      root.update(element());
    });
  };
  await settle();
  return {
    get root() {
      return root;
    },
    settle,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

test('rendered source control mutates URL and selects actual catalog queries in both directions', async () => {
  const view = await mount('scope=all&keep=yes');
  try {
    expect(view.root.root.findByType('output').children).toEqual(['easy-connect']);
    expect(requests).toContain('managed');
    expect(requests).not.toContain('direct');
    const tabs = () =>
      view.root.root.findAll(
        (node) => node.props.value === 'managed' && typeof node.props.onValueChange === 'function',
      )[0];
    await act(async () => tabs().props.onValueChange('direct'));
    await view.settle();
    expect(replacements.at(-1)).toBe('/projects/synthetic/connectors?keep=yes&source=direct');
    expect(view.root.root.findByType('output').children).toEqual(['discover']);
    expect(requests).toContain('direct');
    const directTabs = view.root.root.findAll(
      (node) => node.props.value === 'direct' && typeof node.props.onValueChange === 'function',
    )[0];
    await act(async () => directTabs.props.onValueChange('managed'));
    await view.settle();
    expect(replacements.at(-1)).toBe('/projects/synthetic/connectors?keep=yes');
    expect(view.root.root.findByType('output').children).toEqual(['easy-connect']);
  } finally {
    await view.close();
  }
});

test('flag off ignores a direct deep link and offers no direct source control', async () => {
  const view = await mount('source=direct', false);
  try {
    expect(view.root.root.findByType('output').children).toEqual(['easy-connect']);
    expect(requests).toContain('managed');
    expect(requests).not.toContain('direct');
    expect(
      view.root.root.findAll(
        (node) => node.props.value === 'direct' && typeof node.props.onValueChange === 'function',
      ),
    ).toHaveLength(0);
  } finally {
    await view.close();
  }
});

test('absent managed provider suppresses catalog requests but direct selection still opens direct catalog', async () => {
  const view = await mount('', true, false);
  try {
    expect(view.root.root.findAllByType('output')).toHaveLength(0);
    expect(requests).toEqual([]);
    const tabs = view.root.root.findAll(
      (node) => node.props.value === 'managed' && typeof node.props.onValueChange === 'function',
    )[0];
    await act(async () => tabs.props.onValueChange('direct'));
    await view.settle();
    expect(replacements.at(-1)).toBe('/projects/synthetic/connectors?source=direct');
    expect(view.root.root.findByType('output').children).toEqual(['discover']);
    expect(requests).toContain('direct');
    expect(requests).not.toContain('managed');
  } finally {
    await view.close();
  }
});
