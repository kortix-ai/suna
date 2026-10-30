import type { ProjectLlmCatalogResponse } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  getProjectDetail: async () => ({ project: {} }),
  listProjectSecrets: async () => [],
}));
const sdkReact = await import('@kortix/sdk/react');
let catalog: ProjectLlmCatalogResponse = { models: {} };
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useProjectModelPickerCatalog: () => catalog,
  useRuntimeProviders: () => ({
    data: {
      connected: ['kortix'],
      all: [{ id: 'kortix', models: { 'deepseek-v4.1-flash': { name: 'Sonnet' } } }],
    },
  }),
}));
mock.module('../../../providers/ui-provider', () => ({ useUiHostConfig: () => ({ managedModelsEnabled: true }) }));
mock.module('../../../internal/lib/llm-gateway', () => ({ isLlmGatewayEnabled: () => true }));
mock.module('../../../internal/lib/use-project-can', () => ({ useProjectCan: () => ({ allowed: true }) }));
mock.module('../../../i18n', () => ({
  useTranslations: () => ({ raw: (key: string) => key }),
}));
const { useConnectedProviders } = await import('./use-connected-providers');

test('managed connection follows the live picker, not a stale runtime projection', async () => {
  let connected: string[] = [];
  function Probe() {
    connected = useConnectedProviders('synthetic-project', true).connectedProviders.map(
      (p) => p.id,
    );
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => createElement(QueryClientProvider, { client }, createElement(Probe));
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(tree());
    });
    expect(connected).not.toContain('kortix');
    catalog = { models: { 'deepseek-v4.1-flash': { name: 'Sonnet', provider: 'kortix', enabled: true } } };
    await act(async () => {
      renderer?.update(tree());
    });
    expect(connected).toContain('kortix');
    catalog = { models: { 'deepseek-v4.1-flash': { name: 'Managed', provider: 'kortix', enabled: false } } };
    await act(async () => {
      renderer?.update(tree());
    });
    expect(connected).not.toContain('kortix');
    catalog = { models: {} };
    await act(async () => {
      renderer?.update(tree());
    });
    expect(connected).not.toContain('kortix');
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    client.clear();
  }
});
