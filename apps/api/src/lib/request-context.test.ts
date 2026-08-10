import { describe, expect, test } from 'bun:test';
import {
  getContextFields,
  getDiagnosticFields,
  runWithContext,
  setContextField,
} from './request-context';

describe('getDiagnosticFields', () => {
  test('exposes the allowlisted measurements', () => {
    runWithContext('POST', '/v1/projects/p1/turn-stream', () => {
      setContextField('kind', 'execution_heartbeat');
      setContextField('provider_get_ms', '3');
      setContextField('preview_link_ms', '412');

      expect(getDiagnosticFields()).toEqual({
        kind: 'execution_heartbeat',
        provider_get_ms: '3',
        preview_link_ms: '412',
      });
    });
  });

  test('never exposes identity, even though the context carries it', () => {
    runWithContext('POST', '/v1/projects/p1/turn-stream', () => {
      setContextField('kind', 'execution_heartbeat');
      setContextField('userEmail', 'someone@example.com');
      setContextField('userId', 'user-1');
      setContextField('accountId', 'account-1');
      setContextField('workspaceId', 'project-1');

      const diagnostic = getDiagnosticFields();
      expect(diagnostic).toEqual({ kind: 'execution_heartbeat' });

      const full = getContextFields();
      expect(full.userEmail).toBe('someone@example.com');
      expect(Object.values(diagnostic)).not.toContain('someone@example.com');
      expect(Object.values(diagnostic)).not.toContain('user-1');
      expect(Object.values(diagnostic)).not.toContain('account-1');
    });
  });

  test('is empty outside a request context', () => {
    expect(getDiagnosticFields()).toEqual({});
  });
});
