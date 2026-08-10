import { describe, expect, test } from 'bun:test';
import {
  CONNECTOR_POLL_FIRST_DELAY_MS,
  CONNECTOR_POLL_INTERVAL_MS,
  CONNECTOR_POLL_WINDOW_MS,
  nextConnectorPollDelay,
} from './connector-poll';

describe('nextConnectorPollDelay', () => {
  test('the first poll waits longer than the rest', () => {
    expect(nextConnectorPollDelay(0, 0)).toBe(CONNECTOR_POLL_FIRST_DELAY_MS);
    expect(nextConnectorPollDelay(1, CONNECTOR_POLL_FIRST_DELAY_MS)).toBe(
      CONNECTOR_POLL_INTERVAL_MS,
    );
    expect(nextConnectorPollDelay(9, 60_000)).toBe(CONNECTOR_POLL_INTERVAL_MS);
  });

  test('stops once the next poll would fall outside the window', () => {
    expect(nextConnectorPollDelay(5, CONNECTOR_POLL_WINDOW_MS - CONNECTOR_POLL_INTERVAL_MS)).toBe(
      CONNECTOR_POLL_INTERVAL_MS,
    );
    expect(
      nextConnectorPollDelay(5, CONNECTOR_POLL_WINDOW_MS - CONNECTOR_POLL_INTERVAL_MS + 1),
    ).toBeNull();
    expect(nextConnectorPollDelay(99, CONNECTOR_POLL_WINDOW_MS)).toBeNull();
  });

  test('the schedule fits ~60 polls into the 5-minute window', () => {
    let elapsed = 0;
    let attempt = 0;
    for (;;) {
      const delay = nextConnectorPollDelay(attempt, elapsed);
      if (delay === null) break;
      elapsed += delay;
      attempt += 1;
      if (attempt > 1000) throw new Error('poll schedule never terminates');
    }
    expect(attempt).toBe(60);
    expect(elapsed).toBeLessThanOrEqual(CONNECTOR_POLL_WINDOW_MS);
  });
});
