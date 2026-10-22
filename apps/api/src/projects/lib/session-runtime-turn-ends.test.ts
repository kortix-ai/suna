import { expect, test } from 'bun:test';
import { forgetSessionRuntimeTurnEnds, registerSessionRuntimeTurnEnds, sessionRuntimeTurnEnds } from './session-runtime-turn-ends';

test('runtime end cache shares the reconciler map and forgets it on expiry/reset', () => {
  const ends = new Map<string, number>();
  registerSessionRuntimeTurnEnds('cache-test', ends);
  ends.set('runtime', 123);
  expect(sessionRuntimeTurnEnds('cache-test').get('runtime')).toBe(123);
  forgetSessionRuntimeTurnEnds('cache-test');
  expect(sessionRuntimeTurnEnds('cache-test').size).toBe(0);
});
