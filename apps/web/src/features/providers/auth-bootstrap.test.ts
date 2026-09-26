import { describe, expect, test } from 'bun:test';
import { withAuthBootstrapTimeout } from './auth-bootstrap';

describe('withAuthBootstrapTimeout', () => {
  test('returns a session result that answers before the deadline', async () => {
    await expect(withAuthBootstrapTimeout(Promise.resolve('session'), 20)).resolves.toBe('session');
  });

  test('rejects a request that never answers', async () => {
    await expect(withAuthBootstrapTimeout(new Promise(() => {}), 5)).rejects.toThrow(
      'Authentication did not answer within 5 ms',
    );
  });
});
