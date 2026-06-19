/**
 * Regression test for the 2026-06-18 prod outage: the Better Stack (Logtail)
 * transport overflowed its bounded send-queue, threw "Queue max limit
 * exceeded", and — because the throw was fire-and-forget and the crash handler
 * logged it straight back through the same transport — spiralled, pegging the
 * event loop while cheap /health checks stayed green.
 *
 * The logger must now (a) never let a transport failure surface as an unhandled
 * rejection, and (b) never re-ship the transport's own failures.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type ShipAttempt = { level: string; message: string };

const shipAttempts: ShipAttempt[] = [];

// A transport that ALWAYS fails the way the real one did under overload: the
// returned promise rejects with the throttle's "Queue max limit exceeded".
mock.module('@logtail/node', () => ({
  Logtail: class {
    constructor(_token: string, _options: Record<string, unknown>) {}
    private fail(level: string, message: string): Promise<never> {
      shipAttempts.push({ level, message });
      return Promise.reject(new Error('Queue max limit exceeded'));
    }
    debug(message: string) { return this.fail('debug', message); }
    info(message: string) { return this.fail('info', message); }
    warn(message: string) { return this.fail('warn', message); }
    error(message: string) { return this.fail('error', message); }
    async flush() {}
  },
}));

process.env.BETTERSTACK_API_LOG_TOKEN = 'log-token-test';
process.env.INTERNAL_KORTIX_ENV = 'test';

const { logger, isLoggingTransportError } = await import('../lib/logger');

describe('logger does not spiral when the transport queue overflows', () => {
  beforeEach(() => {
    shipAttempts.length = 0;
  });

  test('isLoggingTransportError flags transport noise only', () => {
    expect(isLoggingTransportError('Queue max limit exceeded')).toBe(true);
    expect(isLoggingTransportError('boom at /app/node_modules/.pnpm/@logtail+tools/dist/throttle.js')).toBe(true);
    expect(isLoggingTransportError('user not found')).toBe(false);
    expect(isLoggingTransportError('Request completed: GET /v1/health 200 0ms')).toBe(false);
  });

  test('a failing transport send never throws and never leaks an unhandled rejection', async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);

    expect(() => logger.error('a real application error while the queue is full')).not.toThrow();
    expect(() => logger.info('a real info line while the queue is full')).not.toThrow();

    // Let any rejection that escaped settle into the unhandledRejection handler.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toBe(0);
    // The real lines were still attempted (we drop on failure, we don't skip).
    expect(shipAttempts.map((s) => s.level)).toEqual(['error', 'info']);
  });

  test("never re-ships the transport's own failures (breaks the feedback loop)", () => {
    logger.error('Queue max limit exceeded at @logtail/tools/throttle.js');
    expect(shipAttempts).toHaveLength(0);

    logger.error('an ordinary downstream failure');
    expect(shipAttempts).toHaveLength(1);
  });

  test('localError / localWarn never touch the transport', () => {
    logger.localError('crash-handler message', { handler: 'unhandledRejection' });
    logger.localWarn('crash-handler warning');
    expect(shipAttempts).toHaveLength(0);
  });
});
