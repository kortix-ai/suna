import { afterEach, describe, expect, test } from 'bun:test';
import { eventStatusFor } from '../lib/trigger-draft';
import { EVENT_TRIGGERS_OFF_MESSAGE, eventTriggersEnabled, eventTriggersOffForProject } from './flag';
import { setEventSourceForTest } from './registry';

const source = (configured: boolean) => ({
  id: 'composio',
  configured: () => configured,
  ingressConfigured: () => true,
  listEventTypes: async () => [],
  listApps: async () => [],
  subscribe: async () => ({ externalId: 'x' }),
  unsubscribe: async () => {},
  receive: async () => ({ deliveries: [], notices: [] }),
});

describe('event_triggers flag helpers', () => {
  afterEach(() => setEventSourceForTest('composio', undefined));

  test('a configured source + project opt-in enables; unset or false is off for the project', () => {
    setEventSourceForTest('composio', source(true));
    expect(eventTriggersEnabled({ experimental: { event_triggers: true } })).toBe(true);
    expect(eventTriggersOffForProject({ experimental: { event_triggers: true } })).toBe(false);
    for (const metadata of [{}, { experimental: { event_triggers: false } }, null]) {
      expect(eventTriggersEnabled(metadata)).toBe(false);
      expect(eventTriggersOffForProject(metadata)).toBe(true);
    }
  });

  test('eventStatusFor reports the off message as error, ahead of any stored row', () => {
    expect(eventStatusFor(undefined, true)).toEqual({ status: 'error', error: EVENT_TRIGGERS_OFF_MESSAGE, last_event_at: null });
    expect(eventStatusFor(undefined)).toEqual({ status: 'pending', error: null, last_event_at: null });
  });
});
