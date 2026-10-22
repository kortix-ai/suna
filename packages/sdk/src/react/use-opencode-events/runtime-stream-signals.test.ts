import { expect, test } from 'bun:test';
import {
  emitRuntimeStreamSignal,
  shouldReconnectOnHostSignal,
  subscribeRuntimeStream,
} from './runtime-stream-signals';

test('every subscriber sees each stream signal until it unsubscribes; a throw is contained', () => {
  const seen: string[] = [];
  const offBad = subscribeRuntimeStream(() => {
    throw new Error('boom');
  });
  const off = subscribeRuntimeStream((signal) => seen.push(signal.type === 'event' ? signal.event.type : signal.type));
  emitRuntimeStreamSignal({ type: 'open' });
  emitRuntimeStreamSignal({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 's' } } as never });
  off();
  emitRuntimeStreamSignal({ type: 'lost' });
  offBad();
  expect(seen).toEqual(['open', 'session.idle']);
});

test('a manual retry always reconnects; visible and online only after 60 s without runtime evidence', () => {
  const now = 1_000_000;
  expect(shouldReconnectOnHostSignal('retry', now, now)).toBe(true);
  expect(shouldReconnectOnHostSignal('visible', now - 59_999, now)).toBe(false);
  expect(shouldReconnectOnHostSignal('visible', now - 60_000, now)).toBe(true);
  expect(shouldReconnectOnHostSignal('online', now - 5_000, now)).toBe(false);
  expect(shouldReconnectOnHostSignal('online', null, now)).toBe(true);
});
