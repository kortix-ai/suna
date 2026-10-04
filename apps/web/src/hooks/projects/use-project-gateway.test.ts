import { expect, test } from 'bun:test';

const web = await import('./use-project-gateway');
const names = [
  'useGatewayOverview', 'useGatewaySeries', 'useGatewayBreakdown', 'useGatewaySessions',
  'useGatewayErrors', 'useGatewayLogs', 'useGatewayLog', 'useGatewayBudgets',
  'useSetGatewayBudget', 'useDeleteGatewayBudget', 'useGatewayKeys',
  'useCreateGatewayKey', 'useRevokeGatewayKey', 'GATEWAY_LOGS_PAGE_SIZE',
] as const;

test('the web gateway shim preserves every SDK hook identity', async () => {
  const sdk = await import('@kortix/sdk/react');
  for (const name of names) expect(web[name]).toBe(sdk[name]);
});
