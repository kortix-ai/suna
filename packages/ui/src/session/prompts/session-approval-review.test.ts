import { approvalReviewable } from './approval-request';
import { testUiTranslator } from '../../test-utils/intl';
import type { SessionAuditAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  approvalArgsPreview,
  approvalArgsSummary,
  approvalNoticeHeadline,
  approvalNoticeRows,
  approvalLauncherName,
  approvalRequestFromAction,
  previewArgsSummary,
  reviewArgsSummary,
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
    acted_by_email: 'sam@example.test',
    resolved_by: null,
    resolved_by_email: null,
    result_summary: {
      args_preview: { subject: 'Weekly report', to: ['sam@example.test'] },
      args_preview_complete: true,
    },
    at: '2026-08-09T10:00:00.000Z',
    resolved_at: null,
    approval_url: 'https://dev.kortix.com/approve/tok-1',
    ...overrides,
  };
}

describe('approvalArgsPreview', () => {
  test('returns the redacted preview object', () => {
    expect(approvalArgsPreview(action())).toEqual({
      subject: 'Weekly report',
      to: ['sam@example.test'],
    });
  });

  test('returns null when the row carries no preview', () => {
    expect(approvalArgsPreview(action({ result_summary: null }))).toBeNull();
    expect(approvalArgsPreview(action({ result_summary: { args_preview: [] } }))).toBeNull();
  });
});

describe('approvalArgsSummary', () => {
  test('puts the target fields first', () => {
    expect(approvalArgsSummary(action())).toBe('to: sam@example.test · subject: Weekly report');
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
      argsPreview: { subject: 'Weekly report', to: ['sam@example.test'] },
      approvalContext: null,
      resolvedPreview: null,
      resolvedFrom: 'gmail',
      resolvedError: null,
      reviewComplete: true,
      resolution: null,
      pending: true,
      canResolve: true,
      resolvers: null,
      status: 'pending_approval',
      resolvedAt: null,
    });
  });

  test("carries the agent's description of an id-only call", () => {
    const row = action({
      result_summary: {
        args_preview: { draft_id: 'r-1' },
        args_preview_complete: true,
        approval_context: 'Sends draft r-1 to a@example.test',
      },
    });
    expect(approvalRequestFromAction(row).approvalContext).toBe('Sends draft r-1 to a@example.test');
  });

  test('carries the content the server loaded, labelled by connector, or its failure', () => {
    const loaded = approvalRequestFromAction(
      action({
        action: 'gmail.send_draft',
        result_summary: { args_preview: { draft_id: 'r-1' }, resolved_preview: { to: 'a@example.test', body: 'Hi' } },
      }),
    );
    expect(loaded).toMatchObject({
      resolvedPreview: { to: 'a@example.test', body: 'Hi' },
      resolvedFrom: 'gmail',
      resolvedError: null,
    });
    const failed = approvalRequestFromAction(
      action({ result_summary: { args_preview: { draft_id: 'r-1' }, resolved_error: 'unavailable' } }),
    );
    expect(failed).toMatchObject({ resolvedPreview: null, resolvedError: 'unavailable' });
  });

  test('reports a shortened preview as incomplete — which no longer blocks it', () => {
    const request = approvalRequestFromAction(
      action({ result_summary: { args_preview: { to: 'a@b.c' }, args_preview_complete: false } }),
    );
    expect(request.reviewComplete).toBe(false);
    // The decision gate is `approvalReviewable`, not this flag: the preview is
    // there, so the call is still decidable.
    expect(approvalReviewable(request.argsPreview, request.reviewComplete)).toBe(true);
  });

  test('a pending row with NO result_summary agrees with the server: unreviewable', () => {
    // `!summary` used to read as "complete", so the card offered an Approve
    // button that POST /approvals/:id answers with 409.
    const request = approvalRequestFromAction(action({ result_summary: null }));
    expect(request.pending).toBe(true);
    expect(request.reviewComplete).toBe(false);
    expect(approvalReviewable(request.argsPreview, request.reviewComplete)).toBe(false);
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

describe('can_resolve (KRTX-1724)', () => {
  test('the request carries the viewer verdict; an older API (absent) keeps the decision', () => {
    expect(approvalRequestFromAction(action({ can_resolve: false })).canResolve).toBe(false);
    expect(approvalRequestFromAction(action({ can_resolve: true })).canResolve).toBe(true);
    expect(approvalRequestFromAction(action()).canResolve).toBe(true);
  });

  test('the request carries who decides; an older API (absent) names nobody', () => {
    expect(approvalRequestFromAction(action({ resolvers: 'managers' })).resolvers).toBe('managers');
    expect(approvalRequestFromAction(action()).resolvers).toBeNull();
  });

  test('the launcher a waiting viewer is told about is a person who started the session', () => {
    const session = {
      owner_name: 'Ada',
      owner_email: 'ada@example.test',
      owner_type: 'user' as const,
      origin: 'user' as const,
    };
    expect(approvalLauncherName(session)).toBe('Ada');
    expect(approvalLauncherName({ ...session, owner_name: null })).toBe('ada@example.test');
    // A service account or a backend wrapper cannot decide: no name.
    expect(approvalLauncherName({ ...session, owner_type: 'service_account' })).toBeNull();
    expect(approvalLauncherName({ ...session, origin: 'backend' })).toBeNull();
    // A row read before the owner was resolved names nobody.
    expect(approvalLauncherName({ ...session, owner_type: 'unknown' })).toBeNull();
    expect(approvalLauncherName(undefined)).toBeNull();
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
    expect(approvalNoticeHeadline(1, testUiTranslator)).toEqual({
      title: 'The agent needs your approval',
      hint: 'waiting for one decision',
    });
  });

  test('counts multiple decisions', () => {
    expect(approvalNoticeHeadline(3, testUiTranslator)).toEqual({
      title: '3 actions need your approval',
      hint: 'waiting for 3 decisions',
    });
  });

  test('drops the waiting hint once nothing is pending', () => {
    expect(approvalNoticeHeadline(0, testUiTranslator)).toEqual({
      title: 'Decision recorded',
      hint: null,
    });
  });
});

// A Slack connector call needing approval showed `channel: C0…` in the session
// (2026-10-02). The session passes the project's bound channel names: the
// summary reads the name, and the parameters keep the exact id beside it.
describe('approvalArgsSummary with Slack channel names', () => {
  test('the summary reads a bound channel by its name', () => {
    const slackAction = {
      ...action(),
      result_summary: { args_preview: { channel: 'C0TEST1', text: 'Deploy done' }, args_preview_complete: true },
    };
    expect(approvalArgsSummary(slackAction, new Map([['C0TEST1', '#general']]))).toBe('channel: #general · text: Deploy done');
    expect(approvalArgsSummary(slackAction)).toBe('channel: C0TEST1 · text: Deploy done');
  });
});

describe('approvalReviewable with resolved content', () => {
  test('a non-empty resolved preview alone is reviewable, like the server gate', () => {
    expect(approvalReviewable(null, false, { body: 'Draft text' })).toBe(true);
    expect(approvalReviewable({}, false, { body: 'Draft text' })).toBe(true);
  });

  test('an empty resolved preview adds nothing', () => {
    expect(approvalReviewable(null, false, {})).toBe(false);
    expect(approvalReviewable(null, false, null)).toBe(false);
  });
});

describe('previewArgsSummary nested values', () => {
  test('renders a nested object as compact JSON', () => {
    expect(previewArgsSummary({ to: 'a@example.test', meta: { cc: ['b@example.test'] } })).toBe(
      'to: a@example.test · meta: {"cc":["b@example.test"]}',
    );
  });

  test('renders objects inside an array as compact JSON', () => {
    expect(previewArgsSummary({ items: [{ id: 1 }, 'x'] })).toBe('items: {"id":1}, x');
  });

  test('still drops a redacted field', () => {
    expect(previewArgsSummary({ token: '[redacted]', to: 'a@example.test' })).toBe(
      'to: a@example.test',
    );
  });
});

describe('reviewArgsSummary', () => {
  test('prefers the resolved content', () => {
    expect(reviewArgsSummary({ subject: 'Hi' }, { draft_id: 'd-1' })).toBe('subject: Hi');
  });

  test('an empty resolved preview falls back to the call arguments', () => {
    expect(reviewArgsSummary({}, { draft_id: 'd-1' })).toBe('draft_id: d-1');
    expect(reviewArgsSummary(null, { draft_id: 'd-1' })).toBe('draft_id: d-1');
  });
});
