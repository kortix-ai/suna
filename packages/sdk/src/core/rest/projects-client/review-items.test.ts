import { describe, expect, test } from 'bun:test';

import type { ApiReviewItem } from './review';
import {
  countReviewItemsBySegment,
  humanizeReviewActionPath,
  mapApiReviewItem,
  reviewItemTarget,
  reviewSegmentForStatus,
  reviewVerdictForStatus,
  type ReviewItem,
} from './review-items';

const changeDetailOf = (item: ReviewItem) =>
  (item as Extract<ReviewItem, { kind: 'change' }>).detail;
const approvalDetailOf = (item: ReviewItem) =>
  (item as Extract<ReviewItem, { kind: 'approval' }>).detail;

const row: ApiReviewItem = {
  review_item_id: 'rv-1',
  account_id: 'acc-1',
  project_id: 'proj-1',
  origin_session_id: null,
  kind: 'output',
  status: 'needs_you',
  risk: 'low',
  source: 'agent',
  title: 'Review the landing page',
  summary: 'Built from the brief',
  detail: { artifactKind: 'page', artifactLabel: 'Landing page', note: 'Look before publish' },
  agent: 'Growth agent',
  created_by: 'user-1',
  acted_by: null,
  acted_at: null,
  feedback: null,
  metadata: {},
  created_at: '2026-06-30T10:00:00.000Z',
  updated_at: '2026-06-30T10:00:00.000Z',
};

describe('mapApiReviewItem', () => {
  test('maps the envelope and normalizes the detail', () => {
    const item = mapApiReviewItem(row);
    expect(item).toMatchObject({
      id: 'rv-1',
      kind: 'output',
      status: 'needs_you',
      risk: 'low',
      source: 'agent',
      title: 'Review the landing page',
      summary: 'Built from the brief',
      agent: 'Growth agent',
      createdAt: '2026-06-30T10:00:00.000Z',
    });
    expect(item.sessionId).toBeUndefined();
    expect(item.detail).toEqual({
      artifactKind: 'page',
      artifactLabel: 'Landing page',
      previewUrl: undefined,
      preview: undefined,
      files: undefined,
      note: 'Look before publish',
    });
  });

  test('falls back to a generic agent label when the row has none', () => {
    expect(mapApiReviewItem({ ...row, agent: '' }).agent).toBe('Agent');
  });

  test('normalizes a thin Change Request detail into a complete change detail', () => {
    const item = mapApiReviewItem({
      ...row,
      review_item_id: 'cr:42',
      kind: 'change',
      summary: 'Change request #2: 7c1e… → main',
      detail: {
        cr_id: '42',
        number: 2,
        base_ref: 'main',
        head_ref: '7c1e0b8a',
        description: 'Adds the pricing page\n\n  Fixes the footer  ',
      },
    });
    expect(item.summary).toBe('#2 → main');
    const detail = changeDetailOf(item);
    expect(detail.crId).toBe('42');
    expect(detail.number).toBe(2);
    expect(detail.whatChanged).toEqual(['Adds the pricing page', 'Fixes the footer']);
    expect(detail.verification).toEqual([]);
    expect(detail.requestedChanges).toEqual([]);
    expect(detail.advanced).toMatchObject({
      headRef: '7c1e0b8a',
      baseRef: 'main',
      additions: 0,
      deletions: 0,
      files: [],
      mergeMode: 'merge',
    });
  });

  test('a change with an empty detail still yields safe arrays and uses the summary', () => {
    const detail = changeDetailOf(mapApiReviewItem({ ...row, kind: 'change', detail: {} }));
    expect(detail.whatChanged).toEqual(['Built from the brief']);
    expect(detail.advanced.files).toEqual([]);
  });

  test('normalizes a thin connector approval into one humanized action', () => {
    const item = mapApiReviewItem({
      ...row,
      review_item_id: 'call:exec-9',
      kind: 'approval',
      risk: 'high',
      title: 'Approve: gmail.send_email',
      detail: {
        execution_id: 'exec-9',
        action_path: 'gmail.send_email',
        args_preview: { to: 'a@b.co', token: '[redacted]', cc: ['x', 'y'] },
        args_preview_complete: true,
      },
    });
    expect(item.title).toBe('(Gmail) Send Email');
    const [action] = approvalDetailOf(item).actions;
    expect(approvalDetailOf(item).actions).toHaveLength(1);
    expect(action).toMatchObject({
      id: 'exec-9',
      title: '(Gmail) Send Email',
      connector: 'gmail',
      action: 'send_email',
      risk: 'high',
      actionPath: 'gmail.send_email',
      reviewComplete: true,
      previewAuthorized: true,
    });
    expect(action.argsPreview).toEqual([
      { key: 'to', value: 'a@b.co' },
      { key: 'token', value: 'Hidden credential' },
      { key: 'cc', value: JSON.stringify(['x', 'y'], null, 2) },
    ]);
  });

  test('a viewer without argument visibility gets previewAuthorized false', () => {
    const item = mapApiReviewItem({
      ...row,
      kind: 'approval',
      detail: { execution_id: 'e', action_path: 'gmail.send_email', args_preview_authorized: false },
    });
    expect(approvalDetailOf(item).actions[0].previewAuthorized).toBe(false);
    expect(approvalDetailOf(item).actions[0].argsPreview).toEqual([]);
  });

  test('an approval summary names the originating session when its label is known', () => {
    const approval: ApiReviewItem = {
      ...row,
      kind: 'approval',
      origin_session_id: 'ses-1',
      summary: 'gmail.send_email',
      detail: { execution_id: 'e', action_path: 'gmail.send_email' },
    };
    expect(mapApiReviewItem(approval, { sessionLabels: { 'ses-1': 'Launch email' } }).summary).toBe(
      'Launch email',
    );
    expect(mapApiReviewItem(approval).summary).toBe('From a running session');
    expect(mapApiReviewItem(approval).sessionId).toBe('ses-1');
  });

  test('a decision defaults its question to the title and its options to an empty list', () => {
    const item = mapApiReviewItem({ ...row, kind: 'decision', title: 'Which plan?', detail: {} });
    expect(item.detail).toEqual({ question: 'Which plan?', context: undefined, options: [] });
  });

  test('a batch defaults its note to the summary and its children to an empty list', () => {
    const item = mapApiReviewItem({ ...row, kind: 'batch', detail: {} });
    expect(item.detail).toEqual({ note: 'Built from the brief', children: [] });
  });
});

describe('humanizeReviewActionPath', () => {
  test('formats connector.action as (Connector) Title Case Action', () => {
    expect(humanizeReviewActionPath('gmail.send_email')).toBe('(Gmail) Send Email');
    expect(humanizeReviewActionPath('google_sheets.rows.append')).toBe(
      '(Google Sheets) Rows Append',
    );
  });

  test('a bare token with no connector prefix is title-cased', () => {
    expect(humanizeReviewActionPath('deploy')).toBe('Deploy');
  });
});

describe('reviewSegmentForStatus', () => {
  test('needs_you and waiting keep their segment; every terminal status is done', () => {
    expect(reviewSegmentForStatus('needs_you')).toBe('needs_you');
    expect(reviewSegmentForStatus('waiting')).toBe('waiting');
    for (const status of ['approved', 'changes_requested', 'rejected', 'done', 'dismissed'] as const) {
      expect(reviewSegmentForStatus(status)).toBe('done');
    }
  });
});

describe('countReviewItemsBySegment', () => {
  test('counts every item once, by status', () => {
    expect(
      countReviewItemsBySegment([
        { status: 'needs_you' },
        { status: 'needs_you' },
        { status: 'waiting' },
        { status: 'approved' },
        { status: 'dismissed' },
      ]),
    ).toEqual({ needs_you: 2, waiting: 1, done: 2 });
  });

  test('an empty list counts zero in every segment', () => {
    expect(countReviewItemsBySegment([])).toEqual({ needs_you: 0, waiting: 0, done: 0 });
  });
});

describe('reviewVerdictForStatus', () => {
  test('maps each terminal status to its verdict; needs_you and waiting have none', () => {
    expect(reviewVerdictForStatus('approved')).toBe('approve');
    expect(reviewVerdictForStatus('rejected')).toBe('reject');
    expect(reviewVerdictForStatus('changes_requested')).toBe('changes');
    expect(reviewVerdictForStatus('done')).toBe('answer');
    expect(reviewVerdictForStatus('dismissed')).toBe('dismiss');
    expect(reviewVerdictForStatus('needs_you')).toBeNull();
    expect(reviewVerdictForStatus('waiting')).toBeNull();
  });
});

describe('reviewItemTarget', () => {
  test('a cr: id acts through the change request flow', () => {
    expect(reviewItemTarget('cr:42')).toEqual({ type: 'change_request', changeRequestId: '42' });
  });

  test('a call: id acts through the connector approval flow', () => {
    expect(reviewItemTarget('call:exec-9')).toEqual({ type: 'connector_call', executionId: 'exec-9' });
  });

  test('any other id is a native review item', () => {
    expect(reviewItemTarget('rv-1')).toEqual({ type: 'review_item', reviewItemId: 'rv-1' });
  });

  test('a bare prefix with no id after it is a native review item', () => {
    expect(reviewItemTarget('cr:')).toEqual({ type: 'review_item', reviewItemId: 'cr:' });
    expect(reviewItemTarget('call:')).toEqual({ type: 'review_item', reviewItemId: 'call:' });
  });
});
