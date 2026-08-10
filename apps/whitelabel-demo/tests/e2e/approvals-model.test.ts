import { describe, expect, test } from 'bun:test';
import type { WorkspaceSessionAudit } from '@kortix/sdk';
import {
  approvalFailure,
  sessionApprovalsView,
} from '../../src/components/workbench/approvals-model';

type Action = WorkspaceSessionAudit['actions'][number];

const action = (over: Partial<Action> = {}): Action => ({
  execution_id: 'exec-1',
  action: 'send_message',
  connector_id: 'conn-1',
  connector: 'slack',
  status: 'pending_approval',
  risk: 'write',
  acted_by: 'user-1',
  acted_by_email: 'agent@example.test',
  resolved_by: null,
  resolved_by_email: null,
  result_summary: null,
  at: '2026-07-29T10:00:00.000Z',
  resolved_at: null,
  ...over,
});

const audit = (
  actions: Action[],
  over: Partial<WorkspaceSessionAudit> = {},
): WorkspaceSessionAudit => ({
  session_id: 'sess-1',
  agent: 'support',
  count: actions.length,
  actions,
  ...over,
});

describe('sessionApprovalsView', () => {
  test('a pending gate surfaces as its fully-qualified tool path', () => {
    // `slack.send_message` is what a workspace policy matches on — the bare
    // action name is ambiguous across connectors, so the row must carry both.
    const view = sessionApprovalsView(audit([action()]));
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]!.action).toBe('slack.send_message');
    expect(view.pending[0]!.executionId).toBe('exec-1');
    expect(view.pending[0]!.risk).toBe('write');
  });

  test('an action whose connector was deleted still renders, by bare action', () => {
    expect(sessionApprovalsView(audit([action({ connector: null })])).pending[0]!.action).toBe(
      'send_message',
    );
  });

  test('an already-resolved row never offers a second decision', () => {
    // The full (Enterprise) trail carries settled rows too, and some keep their
    // original `pending_approval` status. Offering Approve on one of those is a
    // guaranteed 409 — and, worse, reads as "the agent is still blocked".
    const view = sessionApprovalsView(
      audit([
        action({ execution_id: 'live' }),
        action({
          execution_id: 'done',
          resolved_at: '2026-07-29T10:05:00.000Z',
          resolved_by: 'user-2',
          resolved_by_email: 'ops@example.test',
        }),
      ]),
    );
    expect(view.pending.map((r) => r.executionId)).toEqual(['live']);
    expect(view.recent.map((r) => r.executionId)).toEqual(['done']);
    expect(view.recent[0]!.resolvedBy).toBe('ops@example.test');
  });

  test('a withheld trail is reported as withheld, not as "nothing happened"', () => {
    // audit_access:false means the account is not Enterprise, so `actions`
    // carries ONLY unresolved pending gates. Rendering that as an empty history
    // would claim the agent has taken no governed action all session.
    expect(sessionApprovalsView(audit([], { audit_access: false })).trailLimited).toBe(true);
    // Absent on older backends, which served the whole trail — not withheld.
    expect(sessionApprovalsView(audit([])).trailLimited).toBe(false);
  });

  test('no audit at all is empty rather than a crash', () => {
    expect(sessionApprovalsView(null).pending).toEqual([]);
    expect(sessionApprovalsView(undefined).recent).toEqual([]);
  });
});

describe('approvalFailure', () => {
  test('APPROVAL_REQUIRES_HUMAN says a human must decide, in the server’s words', () => {
    // The one refusal that must never render as a generic failure: the caller
    // is session-bound (an agent), so retrying can never succeed. The demo has
    // to name that rather than offering a retry.
    const failure = approvalFailure({
      status: 403,
      code: 'APPROVAL_REQUIRES_HUMAN',
      data: {
        code: 'APPROVAL_REQUIRES_HUMAN',
        error: 'An agent cannot resolve its own approval — a human must approve or deny this',
      },
    });
    expect(failure.kind).toBe('requires_human');
    expect(failure.detail).toContain('cannot resolve its own approval');
    expect(failure.title).not.toContain('Could not');
  });

  test('a plain 403 is "not allowed", which is a different remedy', () => {
    const failure = approvalFailure({
      status: 403,
      // A bare 403 has no code, and the SDK fills `code` with the status text —
      // so the classifier must not read that as a named refusal.
      code: '403',
      data: { error: 'Only a workspace manager or the session launcher can resolve this' },
    });
    expect(failure.kind).toBe('not_permitted');
    expect(failure.detail).toContain('workspace manager');
  });

  test('409 reads as already decided, not as a failure to retry', () => {
    const failure = approvalFailure({
      status: 409,
      code: '409',
      data: { error: 'Approval already resolved' },
    });
    expect(failure.kind).toBe('already_resolved');
  });

  test('an unrecognised failure still says the gate is untouched', () => {
    const failure = approvalFailure(new Error('boom'));
    expect(failure.kind).toBe('unknown');
    expect(failure.detail).toContain('boom');
  });
});
