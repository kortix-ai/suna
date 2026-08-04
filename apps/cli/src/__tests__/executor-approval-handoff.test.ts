import { describe, expect, test } from 'bun:test';
import type { ExecutorClient } from '@kortix/executor-sdk';
import { callWithApprovalHandoff } from '../executor/gateway';

describe('executor approval handoff', () => {
  test('returns the approval URL after one request and never polls', async () => {
    let calls = 0;
    const executor = {
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
    } as unknown as ExecutorClient;

    const result = await callWithApprovalHandoff(executor, 'gmail', 'send_email', {
      to: 'finance@example.com',
    });

    expect(calls).toBe(1);
    expect(result.approval_url).toBe('https://app.kortix.test/approve/token');
  });
});
