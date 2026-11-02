import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const sdk = await import('@kortix/sdk/react');
let models = {};
mock.module('@kortix/sdk/react', () => ({
  ...sdk,
  useModelAccess: () => ({ data: { enforced: true, disabledProviders: [] } }),
  useProjectModelPickerCatalog: () => ({ models }),
}));
mock.module('../sections/llm-provider/use-connected-providers', () => ({
  useConnectedProviders: () => ({ connectedProviders: [], providerStateLoading: false }),
}));
mock.module('../sections/llm-provider/use-live-catalog', () => ({
  useLiveLlmProviderCatalog: () => {},
  useLlmProviderCatalogRevision: () => 0,
}));
let showUpgradeOption = true;
mock.module('../../session/models/use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({ openUpgrade: () => {}, showUpgradeOption }),
}));
const connect = await import('./provider-connect');
mock.module('./provider-connect', () => ({
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
    expect(markup).toContain('Included with a paid plan');
  }
});

test('the managed row says its line once with Upgrade inline, and is absent where billing sells no plan', () => {
  models = {};
  showUpgradeOption = true;
  let markup = renderToStaticMarkup(<ProviderAccordion projectId="synthetic-project" />);
  expect(markup.split('Included with a paid plan').length - 1).toBe(1);
  expect(markup).toContain('Upgrade');
  showUpgradeOption = false;
  markup = renderToStaticMarkup(<ProviderAccordion projectId="synthetic-project" />);
  expect(markup).not.toContain('Included with a paid plan');
  expect(markup).not.toContain('data-accordion-row="kortix"');
  showUpgradeOption = true;
});
