import { expect, test } from 'bun:test';
import { SessionCreateInputSchema } from '../index';

test('session create retains an explicit parent and rejects malformed parents', () => {
  const parent = '11111111-1111-4111-8111-111111111111';
  expect(SessionCreateInputSchema.parse({ parent_session_id: parent })).toEqual({ parent_session_id: parent });
  expect(SessionCreateInputSchema.safeParse({ parent_session_id: '' }).success).toBe(false);
});
