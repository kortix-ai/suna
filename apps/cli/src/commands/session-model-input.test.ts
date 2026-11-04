import { expect, test } from 'bun:test';
import { sessionModelTarget } from './session-model-input';
test('legacy syntax does not borrow the calling session', () => {
  expect(sessionModelTarget(['target', 'model'], 'caller')).toEqual({ action: undefined, sessionId: 'target', model: 'model' });
});
test('new verbs default to the caller but preserve explicit targets', () => {
  expect(sessionModelTarget(['get'], 'caller').sessionId).toBe('caller');
  expect(sessionModelTarget(['set', 'model'], 'caller')).toEqual({ action: 'set', sessionId: 'caller', model: 'model' });
  expect(sessionModelTarget(['switch', 'target', 'model'], 'caller')).toEqual({ action: 'switch', sessionId: 'target', model: 'model' });
  expect(sessionModelTarget(['switch', 'model'], undefined).sessionId).toBeUndefined();
});
