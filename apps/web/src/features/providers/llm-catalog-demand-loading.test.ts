import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { uiSourcePath } from '@/test-utils/read-source';

const projectLayout = readFileSync(
  new URL('../../app/[locale]/(app)/projects/[id]/layout.tsx', import.meta.url),
  'utf8',
);
const providerConnect = readFileSync(uiSourcePath('customize/providers/provider-connect.tsx'), 'utf8');

test('loads the full provider catalog only from the provider-management surface', () => {
  expect(projectLayout).not.toContain('LlmCatalogBootstrap');
  expect(providerConnect).toContain('useLiveLlmProviderCatalog(projectId, enabled)');
  expect(providerConnect).toContain('useLlmProviderCatalogRevision()');
  expect(providerConnect).toContain("LLM_PROVIDERS.filter((provider) => provider.id !== 'kortix')");
});
