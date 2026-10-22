import { expect, test } from 'bun:test';
import { notifyHostSignal, onHostSignal } from './host-signals';

test('a host signal reaches every listener until it unsubscribes', () => {
  const seen: string[] = [];
  const offA = onHostSignal((signal) => seen.push(`a:${signal}`));
  const offB = onHostSignal((signal) => seen.push(`b:${signal}`));
  notifyHostSignal('visible');
  offA();
  notifyHostSignal('online');
  offB();
  notifyHostSignal('retry');
  expect(seen).toEqual(['a:visible', 'b:visible', 'b:online']);
});

test('a throwing listener does not stop the others', () => {
  const seen: string[] = [];
  const offA = onHostSignal(() => {
    throw new Error('boom');
  });
  const offB = onHostSignal((signal) => seen.push(signal));
  expect(() => notifyHostSignal('visible')).not.toThrow();
  expect(seen).toEqual(['visible']);
  offA();
  offB();
});
