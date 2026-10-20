import { expect, test } from 'bun:test';
import * as backfill from '../projects/session-log-backfill';

test('the operator can create a fresh dry pass', () => {
  expect(backfill).toHaveProperty('newBackfillState', expect.any(Function));
});
