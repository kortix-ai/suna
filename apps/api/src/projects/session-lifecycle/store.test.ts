import { describe, expect, test } from 'bun:test';
import { type SessionLifecycleCommandRow, resultFromExistingCommand } from './store';

// A second create with the same idempotency key is answered from the command
// row the first one wrote. The answer tells the caller whether to wait, poll,
// or give up, so each command status maps to exactly one outcome.
describe('resultFromExistingCommand', () => {
  const row = (status: SessionLifecycleCommandRow['status']) =>
    ({
      commandId: 'cmd-1',
      status,
      sessionId: 'sess-1',
      result: {},
      lastError: status === 'dead_lettered' ? 'Project not found' : null,
    }) as SessionLifecycleCommandRow;

  test.each([
    ['succeeded', { status: 'deduped', deduped: true }],
    ['queued', { status: 'queued', deduped: true, retryable: true }],
    ['running', { status: 'pending', deduped: true, retryable: true }],
    [
      'dead_lettered',
      {
        status: 'failed',
        deduped: true,
        retryable: false,
        error: { status: 500, body: { error: 'Project not found' } },
      },
    ],
  ] as const)('a %s command answers with its own outcome', (status, expected) => {
    expect(resultFromExistingCommand(row(status))).toMatchObject({
      ...expected,
      commandId: 'cmd-1',
      sessionId: 'sess-1',
    });
  });
});
