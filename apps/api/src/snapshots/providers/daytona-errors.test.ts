import { expect, test } from 'bun:test';
import { isDaytonaSnapshotNotFoundError } from './daytona';

test('Daytona delete only suppresses confirmed not-found errors', () => {
  expect(isDaytonaSnapshotNotFoundError(Object.assign(new Error('missing'), { statusCode: 404 })))
    .toBe(true);
  expect(isDaytonaSnapshotNotFoundError(new Error('Snapshot with name x not found')))
    .toBe(true);
  expect(isDaytonaSnapshotNotFoundError(new Error('Daytona snapshot.get(x) timed out')))
    .toBe(false);
  expect(isDaytonaSnapshotNotFoundError(Object.assign(new Error('upstream failed'), { statusCode: 503 })))
    .toBe(false);
});
