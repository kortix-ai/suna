import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listAppEventTypes } from './catalog';
import { setEventSourceForTest } from './registry';
import type { EventSourceProvider, EventTypeInfo } from './types';

const info = (type: string): EventTypeInfo => ({ type, name: type, description: '', app: 'synthetic', delivery: 'push', configSchema: {}, payloadSchema: null });
let calls = 0;
let configured = true;
let failure: Error | null = null;
const fake = {
  id: 'composio',
  configured: () => configured,
  ingressConfigured: () => true,
  listEventTypes: async (app: string) => {
    calls++;
    if (failure) throw failure;
    return app === 'synthetic' ? [info('SYNTHETIC_CREATED')] : [];
  },
  listApps: async () => [],
  subscribe: async () => ({ externalId: 'x' }),
  unsubscribe: async () => {},
  receive: async () => ({ deliveries: [], notices: [] }),
} as EventSourceProvider;

beforeEach(() => {
  calls = 0;
  configured = true;
  failure = null;
  setEventSourceForTest('composio', fake);
});
afterEach(() => setEventSourceForTest('composio', undefined));

describe('listAppEventTypes', () => {
  test('lists an app events with no connector, and caches the provider call', async () => {
    const first = await listAppEventTypes('composio', 'synthetic');
    expect(first).toMatchObject({ kind: 'ok', provider: 'composio', app: 'synthetic' });
    await listAppEventTypes('composio', 'synthetic');
    expect(calls).toBe(1);
  });
  test('an app with no events is app_not_found', async () => {
    expect(await listAppEventTypes('composio', 'no-events-app')).toEqual({ kind: 'app_not_found' });
  });
  test('an unknown or unconfigured source is unavailable', async () => {
    expect(await listAppEventTypes('nope', 'synthetic')).toEqual({ kind: 'unavailable' });
    configured = false;
    expect(await listAppEventTypes('composio', 'synthetic')).toEqual({ kind: 'unavailable' });
  });
  test('a provider failure is provider_error', async () => {
    failure = new Error('upstream down');
    expect(await listAppEventTypes('composio', 'other-app')).toEqual({ kind: 'provider_error', message: 'upstream down' });
  });
});
