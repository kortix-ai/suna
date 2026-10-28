import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
let estimate: number | null = 0.00205;
mock.module('@kortix/sdk/react', () => ({
  useGatewayOverview: () => ({ data: { requests: 1, errors: 0, total_cost: 0, estimated_usage_value: estimate, priced_requests: estimate === null ? 0 : 1, unpriced_requests: estimate === null ? 1 : 0, valuation: { coverage: 'LLM only. Subscription fee unknown.', rate_version: 'v1' } } }),
  useGatewayBreakdown: () => ({ data: { models: [] } }),
  useGatewaySeries: () => ({ data: { series: [] } }),
  useGatewaySessions: () => ({ data: { sessions: [] } }),
  useGatewayErrors: () => ({ data: { errors: [] } }),
  useGatewayBudgets: () => ({ data: undefined }),
  useSetGatewayBudget: () => ({ mutate() {} }),
  useDeleteGatewayBudget: () => ({ mutate() {} }),
  qk: { project: { sessions: () => ['sessions'] } },
  contract: () => ({}),
}));
const { GatewayOverview } = await import('./gateway-overview');
function text() {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><GatewayOverview projectId="synthetic" /></QueryClientProvider>).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
test('retail estimate is visible and separate from charges', () => {
  expect(text()).toContain('LLM estimated usage value (not a bill): $0.0021 · 1 priced requests');
  expect(text()).toContain('Estimates are never added to charges.');
});
test('missing pricing is Unknown, not a zero estimate', () => {
  estimate = null;
  expect(text()).toContain('LLM estimated usage value (not a bill): Unknown · 0 priced requests');
  expect(text()).toContain('1 unpriced requests');
});
