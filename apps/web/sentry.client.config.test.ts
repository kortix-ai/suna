import { expect, test } from 'bun:test';
import * as Sentry from '@sentry/nextjs';

// Load the real client configuration without sending telemetry anywhere.
process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@example.test/1';
await import('./sentry.client.config');
const options = Sentry.getClient()?.getOptions();
await Sentry.close();
// init() started a release-health session on the isolation scope. In CI the
// SDK takes the release from GITHUB_SHA, so the test client below would send
// that session as a third envelope. It belongs to the closed client: drop it.
Sentry.getIsolationScope().setSession();

test('client ignoreErrors drops non-Error rejection prefixes and keeps real errors', async () => {
  const envelopes: unknown[] = [];
  const client = new Sentry.NodeClient({
    ...options,
    dsn: 'https://public@example.test/1',
    enabled: true,
    stackParser: Sentry.defaultStackParser,
    sendClientReports: false,
    integrations: [Sentry.eventFiltersIntegration()],
    beforeSend: undefined,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return {}; },
      flush: async () => true,
    }),
  });
  client.init();
  for (const value of [
    'Request timeout lettersVoicesDistributor.getValue',
    'Request timeout appSettingsDistributor.getValue',
    'Request timeout predictionDistributor.getValue',
    'another extension value',
  ]) {
    client.captureEvent({ exception: { values: [{
      type: 'UnhandledRejection',
      value: `Non-Error promise rejection captured with value: ${value}`,
    }] } });
  }
  await client.flush();
  expect(envelopes).toHaveLength(0);
  client.captureException(new Error('Synthetic application failure'));
  client.captureEvent({ message: 'Application quoted Non-Error promise rejection captured' });
  await client.flush();
  expect(envelopes).toHaveLength(2);
  await client.close();
});
