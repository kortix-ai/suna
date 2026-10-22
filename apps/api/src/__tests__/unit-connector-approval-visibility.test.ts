/**
 * The gate must be BOTH informative and enforceable at the args level.
 *
 * Two defects motivated these tests:
 *   1. A gated call recorded only its tool name, so a human was asked to
 *      authorise `send_email` with no way to see the recipient.
 *   2. Policies matched tool names only, so "email only these addresses" was
 *      unexpressible and lived as a prompt instruction the model could ignore.
 *
 * These run the REAL handleCall path with fakes, so they fail if the wiring
 * (not just the pure helpers) regresses.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CallInput,
  type ExecutionRecord,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  handleCall,
} from '../connectors/gateway';
import type { DefaultMode, Policy } from '../connectors/policy';

const MAILER: GatewayConnector = {
  connectorId: 'conn-gmail',
  slug: 'gmail',
  provider: 'openapi',
  baseUrl: 'https://gmail.example.com',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const SEND_EMAIL: GatewayAction = {
  path: 'gmail.send_email',
  relPath: 'send_email',
  inputSchema: { type: 'object', properties: { to: {}, subject: {}, body: {} } },
  risk: 'write',
  binding: {
    kind: 'openapi',
    method: 'POST',
    path: '/v1/send',
    server: 'https://gmail.example.com',
  },
};

const ALLOWED = '/^(owner@example\\.com|admin@example\\.com)$/';

function makeDeps(o: { projectPolicies?: Policy[]; defaultMode?: DefaultMode } = {}) {
  const records: ExecutionRecord[] = [];
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => MAILER,
    loadAction: async () => SEND_EMAIL,
    resolveCredential: async () => 'token-123',
    loadPolicies: async () => [],
    loadProjectPolicies: async () => o.projectPolicies ?? [],
    loadDefaultMode: async () => o.defaultMode ?? 'risk',
    enforcePolicies: true,
    recordExecution: async (r) => {
      records.push(r);
      return 'exec-1';
    },
    mintApprovalLink: ({ projectId, executionId }) =>
      `https://app.example.com/approve/ksl_${projectId}_${executionId}`,
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{"id":"m_1"}' }),
  };
  return { deps, records };
}

function input(args: Record<string, unknown>): CallInput {
  return {
    projectId: 'proj-1',
    accountId: 'acct-1',
    subject: { userId: 'user-1', groupIds: [] },
    // No sessionId: skips the in-session HOLD so the call returns the pending
    // result immediately instead of waiting on a decision.
    sessionId: null,
    connectorSlug: 'gmail',
    actionPath: 'send_email',
    args,
  };
}

describe('a gated call records what it was going to do', () => {
  test('the pending row carries the recipient, not just the tool name', async () => {
    const { deps, records } = makeDeps();

    const res = await handleCall(deps, input({ to: 'stranger@other-company.test', subject: 'Hi' }));

    expect(res.status).toBe('pending_approval');
    const pending = records.find((r) => r.status === 'pending_approval');
    expect(pending?.resultSummary?.args_preview).toEqual({
      to: 'stranger@other-company.test',
      subject: 'Hi',
    });
  });

  test('credential-shaped args never reach the audit trail', async () => {
    const { deps, records } = makeDeps();

    await handleCall(
      deps,
      input({ to: 'stranger@other-company.test', access_token: 'ya29.super-secret' }),
    );

    const pending = records.find((r) => r.status === 'pending_approval');
    expect(JSON.stringify(pending?.resultSummary)).not.toContain('ya29');
    expect((pending?.resultSummary?.args_preview as Record<string, unknown>).access_token).toBe(
      '[redacted]',
    );
  });

  test('a gated call returns a link a human can open, plus a one-line summary', async () => {
    const { deps } = makeDeps();

    const res = await handleCall(deps, input({ to: 'stranger@other-company.test' }));

    expect(res).toMatchObject({
      status: 'pending_approval',
      approvalUrl: 'https://app.example.com/approve/ksl_proj-1_exec-1',
      approvalSummary: 'to: stranger@other-company.test',
    });
  });

  test("an id-only call records the agent's description of its effect, outside the args", async () => {
    const { deps, records } = makeDeps();

    const res = await handleCall(deps, {
      ...input({ draft_id: 'r-1' }),
      approvalContext: '  Sends draft r-1 to stranger@other-company.test, subject "Hi"  ',
    });

    const pending = records.find((r) => r.status === 'pending_approval');
    expect(pending?.resultSummary?.approval_context).toBe(
      'Sends draft r-1 to stranger@other-company.test, subject "Hi"',
    );
    expect(pending?.resultSummary?.args_preview).toEqual({ draft_id: 'r-1' });
    // With a description, the agent is not nagged to add one.
    expect((res as { approvalInstructions?: string }).approvalInstructions).not.toContain(
      'approval_context',
    );
  });

  test('a gated call without a description tells the agent how to add one', async () => {
    const { deps, records } = makeDeps();

    const res = await handleCall(deps, input({ draft_id: 'r-1' }));

    const pending = records.find((r) => r.status === 'pending_approval');
    expect(pending?.resultSummary).not.toHaveProperty('approval_context');
    expect((res as { approvalInstructions?: string }).approvalInstructions).toContain('--reason');
  });

  test("a gated call from a chat session posts an approval card and tells the agent not to repost the link", async () => {
    const { deps } = makeDeps();
    const posted: unknown[] = [];
    deps.postApprovalCard = async (card) => {
      posted.push(card);
      return { posted: true };
    };

    const res = await handleCall(deps, {
      ...input({ draft_id: 'r-1' }),
      sessionId: 'sess-1',
      approvalContext: 'Sends draft r-1',
    });

    expect(posted).toEqual([
      {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        executionId: 'exec-1',
        actionPath: 'gmail.send_email',
        risk: 'write',
        resultSummary: {
          args_preview: { draft_id: 'r-1' },
          args_preview_complete: true,
          approval_context: 'Sends draft r-1',
        },
        approvalUrl: 'https://app.example.com/approve/ksl_proj-1_exec-1',
      },
    ]);
    expect(res).toMatchObject({ status: 'pending_approval', executionId: 'exec-1' });
    const instructions = (res as { approvalInstructions?: string }).approvalInstructions ?? '';
    expect(instructions).toContain('approval card');
    expect(instructions).toContain('Do not repost approval_url');
  });

  test('a card that fails to post never fails the gated call', async () => {
    const { deps } = makeDeps();
    deps.postApprovalCard = async () => {
      throw new Error('slack down');
    };

    const res = await handleCall(deps, { ...input({ draft_id: 'r-1' }), sessionId: 'sess-1' });

    expect(res).toMatchObject({ status: 'pending_approval', executionId: 'exec-1' });
    expect((res as { approvalInstructions?: string }).approvalInstructions).toContain('Share approval_url');
  });

  test('a gated call with no session posts no card', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.postApprovalCard = async () => {
      calls += 1;
      return { posted: true };
    };

    await handleCall(deps, input({ draft_id: 'r-1' }));

    expect(calls).toBe(0);
  });

  test('a policy BLOCK is also recorded with what it blocked', async () => {
    const { deps, records } = makeDeps({
      projectPolicies: [{ match: 'gmail.send_email', action: 'block', position: 0 }],
    });

    const res = await handleCall(deps, input({ to: 'stranger@other-company.test' }));

    expect(res).toEqual({ status: 'denied', reason: 'policy_block' });
    expect(records.at(-1)?.resultSummary?.args_preview).toEqual({
      to: 'stranger@other-company.test',
    });
  });
});

describe('an allow-list is enforced by the connector, not by prompt', () => {
  const allowList: Policy[] = [
    {
      match: 'gmail.send_email',
      action: 'require_approval',
      position: 0,
      conditions: [{ arg: 'to', match: ALLOWED }],
    },
    { match: 'gmail.send_email', action: 'block', position: 1 },
  ];

  test('an off-list recipient is blocked before any request is made', async () => {
    let fetched = false;
    const { deps } = makeDeps({ projectPolicies: allowList });
    deps.fetchImpl = async () => {
      fetched = true;
      return { status: 200, ok: true, text: async () => '{}' };
    };

    const res = await handleCall(deps, input({ to: 'stranger@other-company.test' }));

    expect(res).toEqual({ status: 'denied', reason: 'policy_block' });
    expect(fetched).toBe(false);
  });

  test('an on-list recipient reaches the human gate instead', async () => {
    const { deps } = makeDeps({ projectPolicies: allowList });

    const res = await handleCall(deps, input({ to: 'owner@example.com' }));

    expect(res.status).toBe('pending_approval');
  });

  test('smuggling an extra off-list recipient still blocks', async () => {
    const { deps } = makeDeps({ projectPolicies: allowList });

    const res = await handleCall(
      deps,
      input({ to: ['owner@example.com', 'stranger@other-company.test'] }),
    );

    expect(res).toEqual({ status: 'denied', reason: 'policy_block' });
  });

  test('a separately-guarded cc field is enforced too', async () => {
    const guarded: Policy[] = [
      {
        match: 'gmail.send_email',
        action: 'require_approval',
        position: 0,
        conditions: [
          { arg: 'to', match: ALLOWED },
          { arg: 'cc', match: ALLOWED },
        ],
      },
      { match: 'gmail.send_email', action: 'block', position: 1 },
    ];
    const { deps } = makeDeps({ projectPolicies: guarded });

    const leaked = await handleCall(
      deps,
      input({ to: 'owner@example.com', cc: 'stranger@other-company.test' }),
    );
    expect(leaked).toEqual({ status: 'denied', reason: 'policy_block' });
  });
});
