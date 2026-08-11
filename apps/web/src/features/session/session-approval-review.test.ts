import type { SessionAuditAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  approvalArgsPreview,
  approvalArgsSummary,
  approvalNoticeHeadline,
  approvalNoticeRows,
  approvalRequestFromAction,
  nextExpandedApproval,
} from './session-approval-review';

function action(overrides: Partial<SessionAuditAction> = {}): SessionAuditAction {
  return {
    execution_id: 'exec-1',
    action: 'gmail.send_email',
    connector_id: 'conn-1',
    connector: 'gmail',
    status: 'pending_approval',
    risk: 'write',
    acted_by: 'user-1',
    acted_by_email: 'marko@kortix.ai',
    resolved_by: null,
    resolved_by_email: null,
    result_summary: {
      args_preview: { subject: 'Weekly report', to: ['marko@kortix.ai'] },
      args_preview_complete: true,
    },
    at: '2026-08-09T10:00:00.000Z',
    resolved_at: null,
    approval_url: 'https://dev.dosco.live/approve/tok-1',
    ...overrides,
  };
}

describe('approvalArgsPreview', () => {
  test('returns the redacted preview object', () => {
    expect(approvalArgsPreview(action())).toEqual({
      subject: 'Weekly report',
      to: ['marko@kortix.ai'],
    });
  });

  test('returns null when the row carries no preview', () => {
    expect(approvalArgsPreview(action({ result_summary: null }))).toBeNull();
    expect(approvalArgsPreview(action({ result_summary: { args_preview: [] } }))).toBeNull();
  });
});

describe('approvalArgsSummary', () => {
  test('puts the target fields first', () => {
    expect(approvalArgsSummary(action())).toBe('to: marko@kortix.ai · subject: Weekly report');
  });

  test('stops after two fields', () => {
    const summary = approvalArgsSummary(
      action({
        result_summary: {
          args_preview: { to: 'a@b.c', subject: 'S', body: 'B', url: 'https://x.y' },
        },
      }),
    );
    expect(summary).toBe('to: a@b.c · url: https://x.y');
  });

  test('skips redacted and empty values', () => {
    const summary = approvalArgsSummary(
      action({
        result_summary: {
          args_preview: { access_token: '[redacted]', to: null, subject: '', body: 'Only this' },
        },
      }),
    );
    expect(summary).toBe('body: Only this');
  });

  test('returns null when nothing is displayable', () => {
    expect(
      approvalArgsSummary(action({ result_summary: { args_preview: { token: '[redacted]' } } })),
    ).toBeNull();
  });
});

describe('approvalRequestFromAction', () => {
  test('maps a pending row to the shared request shape', () => {
    expect(approvalRequestFromAction(action())).toEqual({
      action: 'gmail.send_email',
      risk: 'write',
      requestedAt: '2026-08-09T10:00:00.000Z',
      argsPreview: { subject: 'Weekly report', to: ['marko@kortix.ai'] },
      reviewComplete: true,
      resolution: null,
      pending: true,
      status: 'pending_approval',
      resolvedAt: null,
    });
  });

  test('blocks review when the preview is incomplete', () => {
    const request = approvalRequestFromAction(
      action({ result_summary: { args_preview: { to: 'a@b.c' }, args_preview_complete: false } }),
    );
    expect(request.reviewComplete).toBe(false);
  });

  test('reads the recorded decision on a resolved row', () => {
    const request = approvalRequestFromAction(
      action({
        status: 'denied',
        resolved_at: '2026-08-09T10:05:00.000Z',
        result_summary: { args_preview: { to: 'a@b.c' }, decision: 'deny' },
      }),
    );
    expect(request.pending).toBe(false);
    expect(request.resolution).toBe('deny');
    expect(request.reviewComplete).toBe(true);
  });
});

describe('approvalNoticeRows', () => {
  test('keeps only unresolved rows', () => {
    const rows = approvalNoticeRows(
      [
        action({ execution_id: 'exec-1' }),
        action({ execution_id: 'exec-2', status: 'ok', resolved_at: '2026-08-09T10:01:00.000Z' }),
      ],
      {},
    );
    expect(rows.map((row) => row.action.execution_id)).toEqual(['exec-1']);
    expect(rows[0].decision).toBeNull();
  });

  test('orders newest first', () => {
    const rows = approvalNoticeRows(
      [
        action({ execution_id: 'older', at: '2026-08-09T09:00:00.000Z' }),
        action({ execution_id: 'newer', at: '2026-08-09T11:00:00.000Z' }),
      ],
      {},
    );
    expect(rows.map((row) => row.action.execution_id)).toEqual(['newer', 'older']);
  });

  test('keeps a locally decided row after the poll drops it', () => {
    const decidedAction = action({ execution_id: 'exec-9' });
    const rows = approvalNoticeRows([], {
      'exec-9': { action: decidedAction, decision: 'approve' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('approve');
  });

  test('does not duplicate a decided row the poll still returns as pending', () => {
    const pendingAction = action({ execution_id: 'exec-1' });
    const rows = approvalNoticeRows([pendingAction], {
      'exec-1': { action: pendingAction, decision: 'deny' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('deny');
  });
});

describe('approvalNoticeHeadline', () => {
  test('names the single decision', () => {
    expect(approvalNoticeHeadline(1)).toEqual({
      title: 'The agent needs your approval',
      hint: 'waiting for one decision',
    });
  });

  test('counts multiple decisions', () => {
    expect(approvalNoticeHeadline(3)).toEqual({
      title: '3 actions need your approval',
      hint: 'waiting for 3 decisions',
    });
  });

  test('drops the waiting hint once nothing is pending', () => {
    expect(approvalNoticeHeadline(0)).toEqual({ title: 'Decision recorded', hint: null });
  });
});

describe('nextExpandedApproval', () => {
  test('opens a row and collapses the previous one', () => {
    expect(nextExpandedApproval(null, 'exec-1')).toBe('exec-1');
    expect(nextExpandedApproval('exec-1', 'exec-2')).toBe('exec-2');
  });

  test('collapses the row that is already open', () => {
    expect(nextExpandedApproval('exec-1', 'exec-1')).toBeNull();
  });
});
