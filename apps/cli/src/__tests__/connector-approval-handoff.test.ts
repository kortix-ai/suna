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

  test('forwards --reason as approvalContext and drops a bare flag', async () => {
    const seen: unknown[] = [];
    const connector = {
      call: async (_tool: string, _args: unknown, options: unknown) => {
        seen.push(options);
        return { ok: true, data: null, risk: 'write' };
      },
    } as unknown as ConnectorClient;

    await callWithApprovalHandoff(
      connector,
      'gmail',
      'send_draft',
      { draft_id: 'd1' },
      {
        approvalContext: ' Sends draft d1 to a@example.com ',
      },
    );
    await callWithApprovalHandoff(
      connector,
      'gmail',
      'send_draft',
      { draft_id: 'd1' },
      {
        approvalContext: true,
      },
    );

    expect(seen).toEqual([{ approvalContext: 'Sends draft d1 to a@example.com' }, {}]);
  });

  test('drops `output` so the agent sees each payload once, and keeps the contract fields', async () => {
    const connector = {
      call: async () => ({
        ok: true,
        data: { provider: 'composio', result: { messages: [1] } },
        output: { messages: [1] },
        binding: 'composio',
        upstream_status: 200,
        risk: 'read',
      }),
    } as unknown as ConnectorClient;

    const result = await callWithApprovalHandoff(connector, 'gmail', 'fetch_emails', {});

    expect(result).toEqual({
      ok: true,
      data: { provider: 'composio', result: { messages: [1] } },
      binding: 'composio',
      upstream_status: 200,
      risk: 'read',
    } as never);
  });
});
