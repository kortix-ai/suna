import { describe, expect, test } from 'bun:test';
import {
  getContextFields,
  getTraceHeaders,
  runWithContext,
  setContextField,
} from '../lib/request-context';

describe('request context observability fields', () => {
  test('normalizes incoming traceparent and exposes downstream trace headers', () => {
    runWithContext(
      'GET',
      '/v1/projects/project-1/sessions/session-1/sandbox',
      () => {
        const headers = getTraceHeaders();
        expect(headers.traceparent).toMatch(/^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/);
        expect(headers.traceparent).not.toBe('00-11111111111111111111111111111111-2222222222222222-01');
        expect(headers['X-Request-Id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
      },
      '00-11111111111111111111111111111111-2222222222222222-01',
    );
  });

  test('adds snake_case aliases required by structured log sinks', () => {
    runWithContext('POST', '/v1/projects/project-1/sessions', () => {
      setContextField('userId', 'user-1');
      setContextField('accountId', 'account-1');
      setContextField('projectId', 'project-1');
      setContextField('sessionId', 'session-1');
      setContextField('sandboxId', 'sandbox-1');

      const fields = getContextFields();
      expect(fields.requestId).toBe(fields.request_id);
      expect(fields.traceId).toBe(fields.trace_id);
      expect(fields.userId).toBe('user-1');
      expect(fields.user_id).toBe('user-1');
      expect(fields.account_id).toBe('account-1');
      expect(fields.project_id).toBe('project-1');
      expect(fields.session_id).toBe('session-1');
      expect(fields.sandbox_id).toBe('sandbox-1');
    });
  });
});
