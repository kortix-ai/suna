import { expect, test } from 'bun:test';
import { managedPricingRoutes } from './managed-pricing-routes';

test('quotes only enabled routes and includes the customer markup', () => {
  const quotes = managedPricingRoutes(['deepseek-v4.1-flash'], 1.2, true);
  expect(quotes['deepseek-v4.1-flash']).toEqual([
    { route: 'morph', role: 'preferred', input: 0.18, cacheRead: 0.0036, output: 0.72 },
    { route: 'coreweave/fp8', role: 'eligible', input: 0.24, cacheRead: 0.036, output: 0.78 },
  ]);
  expect(quotes['glm-5.3-flash']).toEqual([
    { route: 'decart/fp4', role: 'eligible', input: 0.153, cacheRead: 0.0306, output: 0.51 },
    { route: 'coreweave/nvfp4', role: 'eligible', input: 0.18, cacheRead: 0.06, output: 0.6 },
  ]);
});

test('quotes OpenRouter routes when direct Morph has no credential', () => {
  const quotes = managedPricingRoutes(['kimi-k3'], 1.2, false);
  expect(quotes['kimi-k3']).toEqual([
    { route: 'fireworks/us', role: 'eligible', input: 3.96, cacheRead: 0.396, output: 19.8 },
  ]);
});

test('quotes direct Morph for GLM only after explicit selection', () => {
  const quotes = managedPricingRoutes(['glm-5.3-flash'], 1.2, true);
  expect(quotes['glm-5.3-flash']?.[0]).toEqual({
    route: 'morph', role: 'preferred', input: 0.12, cacheRead: 0.024, output: 0.42,
  });
  expect(quotes['glm-5.3-flash']?.map((route) => route.route)).toEqual([
    'morph', 'decart/fp4', 'coreweave/nvfp4',
  ]);
});
