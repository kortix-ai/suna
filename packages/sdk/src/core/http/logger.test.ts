import { describe, expect, mock, test } from 'bun:test';

// Spy on the raw OpenCode client's `app.log` — the logger used to POST every
// log line to `/p/<box>/8000/log`, one request per line, flooding the box on
// any streaming hot path / retry ladder (dev, 2026-08-27). This asserts the
// logger NEVER touches the raw daemon route.
const appLogCalls: unknown[] = [];
const client = {
  app: {
    log: (input: unknown) => {
      appLogCalls.push(input);
    },
  },
};
mock.module('../runtime/client', () => ({ getClient: () => client }));

const { logger } = await import('./logger');

describe('sdk logger', () => {
  test('never ships log entries to the raw daemon /log route', () => {
    appLogCalls.length = 0;
    logger.error('Stream disconnected', { attempt: 3 });
    logger.warn('slow');
    logger.info('info');
    logger.debug('debug');
    expect(appLogCalls).toHaveLength(0);
  });
});
