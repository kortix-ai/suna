import { describe, expect, test } from 'bun:test';
import {
  ENTER_PROMOTES_PAST_QUEUE,
  SUBMIT_INTERRUPTS_RUNNING_TURN,
  isQueuedSubmission,
} from './send-intent';

describe('the two submit intents', () => {
  test('Cmd+Enter parks the prompt in the composer queue list', () => {
    expect(isQueuedSubmission('queue')).toBe(true);
  });

  test('Enter does not — its prompt waits in the transcript as a dimmed bubble', () => {
    expect(isQueuedSubmission('run')).toBe(false);
  });

  /**
   * The regression this file exists to prevent.
   *
   * An earlier build wired Enter to `stopThenSendNow`, which ABORTS the running
   * turn. The admission gate already holds every queued row until the turn is
   * over, so Enter never needed to interrupt anything — and interrupting threw
   * away the answer the user was waiting for.
   */
  test('NEITHER key ends the turn that is already running', () => {
    expect(SUBMIT_INTERRUPTS_RUNNING_TURN).toBe(false);
  });

  test('an Enter send does not jump rows the user parked earlier', () => {
    expect(ENTER_PROMOTES_PAST_QUEUE).toBe(false);
  });
});
