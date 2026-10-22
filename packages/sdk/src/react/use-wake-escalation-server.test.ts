import { describe, expect, test } from 'bun:test';
import { wakeEscalationViewFromServer } from './use-wake-escalation';

const NOW = Date.parse('2026-10-06T10:01:00.000Z');

describe('wakeEscalationViewFromServer', () => {
  test('a quiet first wake reads as waking, with the silence the server measured', () => {
    const view = wakeEscalationViewFromServer(
      { status: 'waking', retried: false, restarts: 0, max_restarts: 2, silent_since: '2026-10-06T10:00:30.000Z' },
      NOW,
    );
    expect(view).toMatchObject({ status: 'waking', exhausted: false, note: null, summary: null, attemptNumber: 1 });
    expect(view.msSinceProgress).toBe(30_000);
  });

  test('an escalating ladder names the server step it took', () => {
    const view = wakeEscalationViewFromServer(
      { status: 'escalating', retried: true, restarts: 1, max_restarts: 2, silent_since: '2026-10-06T10:01:00.000Z' },
      NOW,
    );
    expect(view.attempts.map((attempt) => attempt.step)).toEqual(['retry-start', 'restart']);
    expect(view.note).toBe('Still waking — restarting the runtime (attempt 3)');
  });

  test('an exhausted ladder says what was tried', () => {
    const view = wakeEscalationViewFromServer(
      { status: 'exhausted', retried: true, restarts: 2, max_restarts: 2, silent_since: null },
      NOW,
    );
    expect(view).toMatchObject({ exhausted: true, msSinceProgress: 0 });
    expect(view.summary).toBe('Tried: re-issuing the wake, then restarting the session twice.');
  });
});
