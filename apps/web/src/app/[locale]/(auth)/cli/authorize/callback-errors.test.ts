import { describe, expect, test } from 'bun:test';

import { callbackTimeoutMessage, callbackUnreachableMessage } from './callback-errors';

// KRTX-1976: when the browser cannot reach the CLI's local callback, the page
// dead-ended on "make sure kortix login is running" and never named the one
// path that needs no callback: a personal key passed to `kortix login --token`.
describe('CLI authorize callback errors', () => {
  test('an unreachable callback names the host, the cause, and the --token fallback', () => {
    const message = callbackUnreachableMessage('cli.localhost:51234', 'Failed to fetch');
    expect(message).toContain('cli.localhost:51234');
    expect(message).toContain('Failed to fetch');
    expect(message).toContain('kortix login --token');
    expect(message).toContain('Personal access keys');
  });

  test('a timed-out delivery offers the same fallback', () => {
    const message = callbackTimeoutMessage('cli.localhost:51234');
    expect(message).toContain('cli.localhost:51234');
    expect(message).toContain('kortix login --token');
  });
});
