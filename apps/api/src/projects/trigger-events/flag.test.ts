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

  test('a configured source enables a project that is on or unset (the default is on); an explicit false is off', () => {
    setEventSourceForTest('composio', source(true));
    for (const metadata of [{ experimental: { event_triggers: true } }, {}, null]) {
      expect(eventTriggersEnabled(metadata)).toBe(true);
      expect(eventTriggersOffForProject(metadata)).toBe(false);
    }
    expect(eventTriggersEnabled({ experimental: { event_triggers: false } })).toBe(false);
    expect(eventTriggersOffForProject({ experimental: { event_triggers: false } })).toBe(true);
  });

  test('eventStatusFor reports the off message as error, ahead of any stored row', () => {
    expect(eventStatusFor(undefined, true)).toEqual({ status: 'error', error: EVENT_TRIGGERS_OFF_MESSAGE, last_event_at: null });
    expect(eventStatusFor(undefined)).toEqual({ status: 'pending', error: null, last_event_at: null });
  });
});
