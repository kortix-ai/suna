import { expect, test } from 'bun:test';
import { sessionLogAppendId } from './session-log-id.ts';

test('keeps the existing turn lease fence identity after extracting the shared codec', () => {
  expect(sessionLogAppendId('kortix.pi.turn-admission.v1\0lease\0msg_test:owner:7')).toBe(
    '598ae3a7-96dd-435a-9274-175cbcc237bb',
  );
  expect(sessionLogAppendId('kortix.pi.permission-approvals.v1\0per_test')).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(sessionLogAppendId('first')).not.toBe(sessionLogAppendId('second'));
});
