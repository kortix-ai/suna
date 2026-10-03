import { describe, expect, test } from 'bun:test';

import { reviewApprovalDetails } from './approval-modal';
import type { ReviewItem } from './types';

const connectorCall: ReviewItem = {
  id: 'call:exec-1',
  kind: 'approval',
  status: 'needs_you',
  risk: 'medium',
  title: 'Send email (Gmail)',
  project: 'Project 1',
  agent: 'Agent 1',
  createdAt: '2026-10-02T10:00:00.000Z',
  sessionId: 'session-1',
  primaryAction: 'Approve',
  detail: {
    actions: [
      {
        id: 'exec-1',
        title: 'Send email (Gmail)',
        connector: 'gmail',
        action: 'send_email',
        consequence: 'Runs against the real connector once you approve',
        risk: 'medium',
        icon: 'generic',
        argsPreview: [{ key: 'to', value: 'person@example.test' }],
        actionPath: 'gmail.send_email',
        rawArgsPreview: { to: 'person@example.test', subject: 'Draft' },
        reviewComplete: true,
        approvalContext: 'Send the draft to the reviewer',
        connectorRisk: 'write',
        policySource: 'Requires approval',
      },
    ],
  },
} as ReviewItem;

describe('reviewApprovalDetails', () => {
  test('a Connector call reads exactly as the approve page loads it', () => {
    expect(reviewApprovalDetails(connectorCall)).toMatchObject({
      execution_id: 'exec-1',
      session_id: 'session-1',
      project_name: 'Project 1',
      action: 'gmail.send_email',
      connector: 'gmail',
      risk: 'write',
      pending: true,
      status: 'pending_approval',
      args_preview: { to: 'person@example.test', subject: 'Draft' },
      review_complete: true,
      approval_context: 'Send the draft to the reviewer',
    });
  });

  test('a decided call is no longer pending and carries its outcome', () => {
    expect(reviewApprovalDetails({ ...connectorCall, status: 'approved' })).toMatchObject({
      pending: false,
      status: 'ok',
    });
    expect(reviewApprovalDetails({ ...connectorCall, status: 'rejected' })).toMatchObject({
      pending: false,
      status: 'denied',
    });
  });

  test('anything that is not one Connector call keeps the review page', () => {
    expect(reviewApprovalDetails({ ...connectorCall, id: 'rv-native' })).toBeNull();
    expect(
      reviewApprovalDetails({ ...connectorCall, detail: { actions: [] } } as ReviewItem),
    ).toBeNull();
  });
});
