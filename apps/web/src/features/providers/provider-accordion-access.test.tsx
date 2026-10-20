import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const sdk = await import('@kortix/sdk/react');
let models = {};
mock.module('@kortix/sdk/react', () => ({
  ...sdk,
  useModelAccess: () => ({ data: { enforced: true, disabledProviders: [] } }),
  useProjectModelPickerCatalog: () => ({ models }),
}));
mock.module('@/features/workspace/customize/sections/llm-provider/use-connected-providers', () => ({
  useConnectedProviders: () => ({ connectedProviders: [], providerStateLoading: false }),
}));
mock.module('@/features/workspace/customize/sections/llm-provider/use-live-catalog', () => ({
  useLiveLlmProviderCatalog: () => {},
  useLlmProviderCatalogRevision: () => 0,
}));
const connect = await import('./provider-connect');
mock.module('@/features/providers/provider-connect', () => ({
  ...connect,
  usePooledProviderIds: () => ({ pooledProviderIds: new Set(), isLoading: false }),
}));
const { ProviderAccordion } = await import('./provider-accordion');

test('quick Models dialog does not advertise a managed provider with no usable models', () => {
  for (const catalog of [{}, { 'synthetic-managed': { name: 'Managed', enabled: false } }]) {
    models = catalog;
    const markup = renderToStaticMarkup(<ProviderAccordion projectId="synthetic-project" />);
    expect(markup).not.toContain('Paid from credits');
    expect(markup).not.toContain('aria-label="Included"');
    expect(markup).toContain('connect your own provider');
  }
});
