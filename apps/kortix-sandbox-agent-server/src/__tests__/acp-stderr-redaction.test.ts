import { describe, expect, test } from 'bun:test';

import { redactHarnessStderr } from '../acp/runtime';

describe('ACP harness stderr redaction', () => {
  test('removes credentials embedded inside adapter diagnostics', () => {
    const line = 'auth={"Authorization":"Bearer sandbox-token-123"} key=sk-project-456';
    expect(redactHarnessStderr(line, {
      KORTIX_TOKEN: 'sandbox-token-123',
      OPENAI_API_KEY: 'sk-project-456',
      SAFE_VALUE: 'visible',
    })).toBe('auth={"Authorization":"Bearer [REDACTED]"} key=[REDACTED]');
  });
});
