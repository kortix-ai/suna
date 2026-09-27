import { describe, expect, test } from 'bun:test';
import type { Part } from '@kortix/sdk';
import {
  connectorApprovalNeed,
  connectorApprovalState,
  connectorConnectNeed,
  connectorHandoffCallIds,
  connectorHandoffCopy,
  connectorHandoffToast,
  isConnectorCallTool,
  isConnectorConnected,
  prettifyConnectorName,
} from './connector-handoff';

describe('prettifyConnectorName', () => {
  test('title-cases snake/kebab slugs', () => {
    expect(prettifyConnectorName('google_drive')).toBe('Google Drive');
    expect(prettifyConnectorName('gmail')).toBe('Gmail');
    expect(prettifyConnectorName('hub-spot')).toBe('Hub Spot');
  });

  test('falls back to the slug itself when it yields nothing', () => {
    expect(prettifyConnectorName('')).toBe('');
    expect(prettifyConnectorName('___')).toBe('___');
  });
});

describe('connectorConnectNeed', () => {
  const input = { connector: 'gmail', action: 'send_email' };

  test('null when parsed is null', () => {
    expect(connectorConnectNeed(input, null)).toBeNull();
  });

  test('null when the call succeeded', () => {
    expect(connectorConnectNeed(input, { ok: true, status: 'ok' })).toBeNull();
  });

  test('null when denied for a reason other than connector_not_connected', () => {
    expect(
      connectorConnectNeed(input, { ok: false, status: 'denied', reason: 'account_required' }),
    ).toBeNull();
  });

  test('null when connector_not_connected but the denial minted no link', () => {
    expect(
      connectorConnectNeed(input, {
        ok: false,
        status: 'denied',
        reason: 'connector_not_connected',
      }),
    ).toBeNull();
  });

  test('extracts slug + label + url from a connect_url denial', () => {
    expect(
      connectorConnectNeed(input, {
        ok: false,
        status: 'denied',
        reason: 'connector_not_connected',
        connect_url: 'https://kortix.com/connect/abc123',
      }),
    ).toEqual({ slug: 'gmail', label: 'Gmail', connectUrl: 'https://kortix.com/connect/abc123' });
  });

  test('falls back to the tool input connector when the payload omits it', () => {
    expect(
      connectorConnectNeed(input, {
        ok: false,
        status: 'denied',
        reason: 'connector_not_connected',
        connect_url: 'https://kortix.com/connect/abc123',
        connector: undefined,
      }),
    ).toEqual({ slug: 'gmail', label: 'Gmail', connectUrl: 'https://kortix.com/connect/abc123' });
  });

  test('null when neither payload nor input names a connector', () => {
    expect(
      connectorConnectNeed(
        {},
        {
          ok: false,
          status: 'denied',
          reason: 'connector_not_connected',
          connect_url: 'https://kortix.com/connect/abc123',
        },
      ),
    ).toBeNull();
  });
});

describe('connectorApprovalNeed', () => {
  const input = { connector: 'gmail', action: 'send_email' };

  test('null when not pending_approval', () => {
    expect(connectorApprovalNeed(input, { ok: false, status: 'denied' })).toBeNull();
    expect(connectorApprovalNeed(input, null)).toBeNull();
  });

  test('null when the payload has no execution id', () => {
    expect(connectorApprovalNeed(input, { status: 'pending_approval' })).toBeNull();
  });

  test('extracts the approval fields', () => {
    expect(
      connectorApprovalNeed(input, {
        status: 'pending_approval',
        execution_id: 'exec_1',
        approval_summary: 'Send an email to legal@acme.test',
        approval_instructions: 'Review the recipient before approving.',
        risk: 'write',
      }),
    ).toEqual({
      executionId: 'exec_1',
      connector: 'gmail',
      action: 'send_email',
      actionRef: 'gmail.send_email',
      argsPreview: [],
      summary: 'Send an email to legal@acme.test',
      instructions: 'Review the recipient before approving.',
      risk: 'write',
    });
  });

  test('previews the call arguments: strings as-is, others as JSON, long values cut, at most 4', () => {
    const need = connectorApprovalNeed(
      {
        connector: 'gmail',
        action: 'send_email',
        args: {
          to: 'someone@example.test',
          cc: ['a@example.test'],
          subject: 'Hello',
          body: 'x'.repeat(200),
          extra: 'dropped',
        },
      },
      { status: 'pending_approval', execution_id: 'exec_1' },
    );
    expect(need?.argsPreview).toEqual([
      { key: 'to', value: 'someone@example.test' },
      { key: 'cc', value: '["a@example.test"]' },
      { key: 'subject', value: 'Hello' },
      { key: 'body', value: `${'x'.repeat(79)}…` },
    ]);
  });

  test('actionRef falls back to whichever of connector / action exists', () => {
    const need = connectorApprovalNeed({ action: 'send_email' }, { status: 'pending_approval', execution_id: 'e' });
    expect(need?.actionRef).toBe('send_email');
  });
});

describe('isConnectorCallTool', () => {
  test('matches the registry spellings of kortix-connectors_call', () => {
    expect(isConnectorCallTool('kortix-connectors_call')).toBe(true);
    expect(isConnectorCallTool('kortix_connectors_call')).toBe(true);
    expect(isConnectorCallTool('kortix-connectors-call')).toBe(true);
    expect(isConnectorCallTool('mcp/kortix-connectors_call')).toBe(true);
  });

  test('rejects the other connector tools', () => {
    expect(isConnectorCallTool('kortix-connectors_discover')).toBe(false);
    expect(isConnectorCallTool('kortix-connectors_connectors')).toBe(false);
    expect(isConnectorCallTool('bash')).toBe(false);
  });
});

function toolPart(callID: string, tool: string, state: Record<string, unknown>): { part: Part } {
  return {
    part: {
      type: 'tool',
      id: `prt_${callID}`,
      callID,
      tool,
      sessionID: 's',
      messageID: 'm',
      state: { input: {}, ...state },
    } as unknown as Part,
  };
}

describe('connectorHandoffCallIds', () => {
  const connect = JSON.stringify({
    ok: false,
    status: 'denied',
    reason: 'connector_not_connected',
    connect_url: 'https://kortix.com/connect/abc',
    connector: 'gmail',
  });
  const approval = JSON.stringify({ status: 'pending_approval', execution_id: 'exec_1', connector: 'gmail' });

  test('collects connect-need and approval-need calls, nothing else', () => {
    const ids = connectorHandoffCallIds([
      toolPart('c1', 'kortix-connectors_call', { status: 'completed', output: connect }),
      toolPart('c2', 'kortix-connectors_call', { status: 'completed', output: approval }),
      toolPart('c3', 'kortix-connectors_call', { status: 'completed', output: JSON.stringify({ ok: true }) }),
      toolPart('c4', 'bash', { status: 'completed', output: approval }),
      { part: { type: 'text', id: 't', text: 'hi' } as unknown as Part },
    ]);
    expect(ids).toEqual(['c1', 'c2']);
  });

  test('a running or unparsable call is not a hand-off', () => {
    expect(
      connectorHandoffCallIds([
        toolPart('c1', 'kortix-connectors_call', { status: 'running' }),
        toolPart('c2', 'kortix-connectors_call', { status: 'completed', output: 'not json' }),
      ]),
    ).toEqual([]);
  });
});

describe('connectorApprovalState', () => {
  const base = {
    executionId: 'exec_1',
    reviewItems: [] as { id: string; status: string }[] | undefined,
    reviewFetchedAtMs: 2_000,
    reviewFailed: false,
    callSettledAtMs: 1_000,
    localDecision: null as 'approve' | 'deny' | null,
  };

  test('a decision made here wins', () => {
    expect(connectorApprovalState({ ...base, localDecision: 'approve' })).toBe('approved');
    expect(connectorApprovalState({ ...base, localDecision: 'deny' })).toBe('denied');
  });

  test('unknown while the review list has not loaded', () => {
    expect(connectorApprovalState({ ...base, reviewItems: undefined, reviewFetchedAtMs: 0 })).toBe('unknown');
  });

  test('pending when the list failed to load: the static output is the only signal left', () => {
    expect(connectorApprovalState({ ...base, reviewItems: undefined, reviewFailed: true })).toBe('pending');
  });

  test('pending while the review list still carries the call', () => {
    expect(
      connectorApprovalState({ ...base, reviewItems: [{ id: 'call:exec_1', status: 'needs_you' }] }),
    ).toBe('pending');
  });

  test('resolved once a list fetched after the call no longer carries it (decided on web or on Review)', () => {
    expect(connectorApprovalState({ ...base, reviewItems: [{ id: 'call:other', status: 'needs_you' }] })).toBe(
      'resolved',
    );
  });

  test('a list fetched before the call settled cannot prove a resolution yet', () => {
    expect(connectorApprovalState({ ...base, reviewFetchedAtMs: 500 })).toBe('pending');
  });

  test('a terminal status on the item names the outcome', () => {
    expect(connectorApprovalState({ ...base, reviewItems: [{ id: 'call:exec_1', status: 'approved' }] })).toBe(
      'approved',
    );
    expect(connectorApprovalState({ ...base, reviewItems: [{ id: 'call:exec_1', status: 'rejected' }] })).toBe(
      'denied',
    );
    expect(connectorApprovalState({ ...base, reviewItems: [{ id: 'call:exec_1', status: 'dismissed' }] })).toBe(
      'resolved',
    );
  });
});

describe('connectorHandoffCopy', () => {
  test('names the provider in the title, and keeps the body provider-agnostic', () => {
    expect(connectorHandoffCopy('Gmail')).toEqual({
      title: 'Connect Gmail',
      body: "Sign in on kortix.com. You come back to this chat when it's done.",
    });
  });
});

describe('connectorHandoffToast', () => {
  test('names the provider both ways', () => {
    expect(connectorHandoffToast('Gmail', true)).toBe('Gmail connected');
    expect(connectorHandoffToast('Gmail', false)).toBe('Gmail not connected');
  });
});

describe('isConnectorConnected', () => {
  test('true only when secretSet is true', () => {
    expect(isConnectorConnected({ secretSet: true })).toBe(true);
    expect(isConnectorConnected({ secretSet: false })).toBe(false);
    expect(isConnectorConnected(null)).toBe(false);
    expect(isConnectorConnected(undefined)).toBe(false);
  });
});
