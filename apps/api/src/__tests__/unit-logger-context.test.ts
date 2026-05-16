import { beforeEach, describe, expect, mock, test } from 'bun:test';

type LogCall = {
  level: string;
  message: string;
  context: Record<string, unknown>;
};

const logCalls: LogCall[] = [];

mock.module('@logtail/node', () => ({
  Logtail: class {
    token: string;
    options: Record<string, unknown>;

    constructor(token: string, options: Record<string, unknown>) {
      this.token = token;
      this.options = options;
    }

    debug(message: string, context: Record<string, unknown>) {
      logCalls.push({ level: 'debug', message, context });
    }

    info(message: string, context: Record<string, unknown>) {
      logCalls.push({ level: 'info', message, context });
    }

    warn(message: string, context: Record<string, unknown>) {
      logCalls.push({ level: 'warn', message, context });
    }

    error(message: string, context: Record<string, unknown>) {
      logCalls.push({ level: 'error', message, context });
    }

    async flush() {}
  },
}));

process.env.BETTERSTACK_API_LOG_TOKEN = 'log-token-test';
process.env.BETTERSTACK_API_LOG_HOST = 'logs.example.test';
process.env.INTERNAL_KORTIX_ENV = 'test';
process.env.SANDBOX_VERSION = 'test-version';

const { logger } = await import('../lib/logger');
const {
  runWithContext,
  setContextField,
} = await import('../lib/request-context');

describe('managed structured logger', () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  test('ships request context fields to Better Stack log payloads', () => {
    runWithContext(
      'POST',
      '/v1/projects/project-1/sessions/session-1',
      () => {
        setContextField('userId', 'user-1');
        setContextField('accountId', 'account-1');
        setContextField('projectId', 'project-1');
        setContextField('sessionId', 'session-1');

        logger.info('Request completed: POST /v1/projects/project-1/sessions/session-1 201 42ms', {
          status: 201,
          duration: 42,
        });
      },
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].level).toBe('info');
    expect(logCalls[0].message).toContain('Request completed');
    expect(logCalls[0].context).toMatchObject({
      service: 'kortix-api',
      env: 'test',
      version: 'test-version',
      method: 'POST',
      path: '/v1/projects/project-1/sessions/session-1',
      user_id: 'user-1',
      account_id: 'account-1',
      project_id: 'project-1',
      session_id: 'session-1',
      status: 201,
      duration: 42,
    });
    expect(logCalls[0].context.request_id).toBe(logCalls[0].context.requestId);
    expect(logCalls[0].context.trace_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(logCalls[0].context.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(logCalls[0].context.parent_span_id).toBe('bbbbbbbbbbbbbbbb');
  });
});
