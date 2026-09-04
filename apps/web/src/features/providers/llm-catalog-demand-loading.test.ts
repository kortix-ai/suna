import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const projectLayout = readFileSync(
  new URL('../../app/(app)/projects/[id]/layout.tsx', import.meta.url),
  'utf8',
);
const providerConnect = readFileSync(new URL('./provider-connect.tsx', import.meta.url), 'utf8');

test('loads the full provider catalog only from the provider-management surface', () => {
  expect(projectLayout).not.toContain('LlmCatalogBootstrap');
  expect(providerConnect).toContain('useLiveLlmProviderCatalog(projectId, enabled)');
  expect(providerConnect).toContain('useLlmProviderCatalogRevision()');
  expect(providerConnect).toContain("LLM_PROVIDERS.filter((provider) => provider.id !== 'kortix')");
});
