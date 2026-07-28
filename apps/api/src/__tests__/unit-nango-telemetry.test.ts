import { describe, expect, test } from 'bun:test';
import {
  createNangoRequestObserver,
  recordGithubCredentialState,
  recordNangoWebhookResult,
} from '../projects/nango/telemetry';

function recordingLogger() {
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  return {
    entries,
    logger: {
      info: (message: string, fields?: Record<string, unknown>) =>
        entries.push({ level: 'info', message, fields }),
      warn: (message: string, fields?: Record<string, unknown>) =>
        entries.push({ level: 'warn', message, fields }),
    },
  };
}

describe('Nango telemetry', () => {
  test('records request latency and sanitized provider errors', () => {
    const capture = recordingLogger();
    const observe = createNangoRequestObserver('account', capture.logger);
    observe({
      operation: 'get_connection',
      outcome: 'error',
      latencyMs: 17,
      upstreamStatus: 429,
      errorCode: 'github_provider_rate_limited',
    });

    expect(capture.entries).toEqual([
      {
        level: 'warn',
        message: 'Nango request completed',
        fields: {
          event: 'nango_request',
          provider: 'github',
          credential_source: 'nango',
          scope: 'account',
          operation: 'get_connection',
          outcome: 'error',
          latency_ms: 17,
          upstream_status: 429,
          error_code: 'github_provider_rate_limited',
        },
      },
    ]);
  });

  test('records credential state and webhook results without identifiers or credentials', () => {
    const capture = recordingLogger();
    recordGithubCredentialState(
      {
        scope: 'managed',
        state: 'connected',
        outcome: 'success',
      },
      capture.logger,
    );
    recordNangoWebhookResult(
      {
        status: 409,
        outcome: 'error',
        errorCode: 'github_reconnect_required',
      },
      capture.logger,
    );

    const serialized = JSON.stringify(capture.entries);
    expect(serialized).toContain('"credential_source":"nango"');
    expect(serialized).toContain('"connection_state":"connected"');
    expect(serialized).toContain('"event":"nango_webhook_result"');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('connection_id');
    expect(serialized).not.toContain('account_id');
  });
});
