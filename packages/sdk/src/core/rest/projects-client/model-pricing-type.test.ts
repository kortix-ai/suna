import { expect, test } from 'bun:test';
import type { ProjectLlmCatalogResponse } from './projects';

test('the model picker declares provider-specific customer prices', () => {
  const routes: NonNullable<ProjectLlmCatalogResponse['managedPricingRoutes']> = {
    'glm-5.3-flash': [
      { route: 'decart/fp4', role: 'eligible', input: 0.153, cacheRead: 0.0306, output: 0.51 },
    ],
  };
  expect(routes['glm-5.3-flash']?.[0]?.route).toBe('decart/fp4');
});
