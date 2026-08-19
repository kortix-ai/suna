import { describe, expect, test } from 'bun:test';
import type { ConnectorClient } from '../connector-gateway/gateway';
import { callWithApprovalHandoff } from '../connector-gateway/gateway';

describe('connector approval handoff', () => {
  test('returns the approval URL after one request and never polls', async () => {
    let calls = 0;
    const connector = {
      call: async () => {
        calls += 1;
        return {
          ok: false,
          status: 'pending_approval',
          execution_id: 'exec-1',
          retryable: false,
          approval_url: 'https://app.kortix.test/approve/token',
          approval_summary: 'to: finance@example.com',
        };
      },
    } as unknown as ConnectorClient;

    const result = await callWithApprovalHandoff(connector, 'gmail', 'send_email', {
      to: 'finance@example.com',
    });

    expect(calls).toBe(1);
    expect(result.approval_url).toBe('https://app.kortix.test/approve/token');
  });
});
