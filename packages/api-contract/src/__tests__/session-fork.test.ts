import { expect, test } from 'bun:test';
import { SessionCreateInputSchema } from '../index';
test('platform fork source survives validation and rejects empty identifiers', () => {
  expect(SessionCreateInputSchema.strict().parse({ fork_from_session_id: 'synthetic-source' })).toEqual({ fork_from_session_id: 'synthetic-source' });
  expect(SessionCreateInputSchema.safeParse({ fork_from_session_id: '' }).success).toBe(false);
});
