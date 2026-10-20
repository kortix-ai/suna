import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { managedPricingRoutes, refreshManagedPricingRoutes } from './managed-pricing-routes';

// The quoted OpenRouter members follow the subprocessor dates
// (`inferenceHostCleared`): Fireworks is in effect, DeepInfra, Together,
// Parasail and Modal from 2026-11-24, unlisted hosts never.
beforeEach(() => setSystemTime(new Date('2026-10-20T12:00:00Z')));
afterEach(() => setSystemTime());

const routes = (quotes: Record<string, { route: string }[]>, id: string) => quotes[id]?.map((quote) => quote.route);

test('quotes only routes a request may reach today, with the customer markup', () => {
  const quotes = managedPricingRoutes(['deepseek-v4.1-flash', 'glm-5.3-flash'], 1.2, true);
  expect(quotes['deepseek-v4.1-flash']).toEqual([
    { route: 'morph', role: 'preferred', input: 0.18, cacheRead: 0.0036, output: 0.72 },
  ]);
  expect(quotes['glm-5.3-flash']).toEqual([
    { route: 'morph', role: 'preferred', input: 0.12, cacheRead: 0.024, output: 0.42 },
    { route: 'fireworks', role: 'eligible', input: 0.18, cacheRead: 0.036, output: 0.6 },
  ]);
});

test('a host joins the quote on its subprocessor date, an unlisted host never does', () => {
  setSystemTime(new Date('2026-11-25T12:00:00Z'));
  const quotes = managedPricingRoutes([], 1.2, false);
  expect(routes(quotes, 'deepseek-v4.1-flash')).toEqual(['deepinfra/fp8', 'deepinfra/fp8/priority']);
  expect(routes(quotes, 'glm-5.3-flash')).toEqual(['fireworks', 'deepinfra/fp4', 'together', 'parasail/fp4', 'modal/nvfp4']);
});

test('omits OpenRouter quotes when its credential is absent', () => {
  const quotes = managedPricingRoutes(['deepseek-v4.1-flash'], 1.2, true, false);
  expect(routes(quotes, 'deepseek-v4.1-flash')).toEqual(['morph']);
  expect(quotes['glm-5.3-flash']).toBeUndefined();
});

const feed = (endpoints: object[]) => async (url: RequestInfo | URL) =>
  Response.json({ data: { endpoints: String(url).includes('glm-5.3-flash') ? endpoints : [] } });

test('refreshes an allowed endpoint from live per-token pricing; a price equal to the cap stays', async () => {
  const quoted = await refreshManagedPricingRoutes([], 1.2, false, {
    baseUrl: 'https://openrouter.test/api/v1', apiKey: 'test-key',
    // 0.00000015 * 1e6 is 0.15000000000000002 in float math; the cap is 0.15.
    fetchImpl: feed([{ tag: 'fireworks', pricing: { prompt: '0.00000015', input_cache_read: '0.00000002', completion: '0.0000004' } }]),
  });
  expect(quoted['glm-5.3-flash']).toEqual([{ route: 'fireworks', role: 'eligible', input: 0.18, cacheRead: 0.024, output: 0.48 }]);
});

test('omits an endpoint whose live price exceeds the cap, and keeps the table when the feed fails', async () => {
  const over = await refreshManagedPricingRoutes([], 1.2, false, {
    baseUrl: 'https://openrouter.test/api/v1', apiKey: 'test-key',
    fetchImpl: feed([{ tag: 'fireworks', pricing: { prompt: '0.00001', input_cache_read: '0.00000002', completion: '0.00001' } }]),
  });
  expect(routes(over, 'glm-5.3-flash')).toEqual([]);
  const down = await refreshManagedPricingRoutes([], 1.2, false, {
    baseUrl: 'https://openrouter.test/api/v1', apiKey: 'test-key',
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  expect(down['glm-5.3-flash']?.[0]?.input).toBe(0.18);
});
