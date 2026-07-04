import { describe, expect, test } from 'bun:test';
import type { ApiReviewItem } from '@kortix/sdk/projects-client';
import {
  PRIMARY_ACTION,
  agentInitials,
  humanizeActionPath,
  mapApiReviewItem,
  statusToVerdict,
} from './map';
import type { ReviewItem } from './types';

const changeDetailOf = (i: ReviewItem) => (i as Extract<ReviewItem, { kind: 'change' }>).detail;
const approvalDetailOf = (i: ReviewItem) => (i as Extract<ReviewItem, { kind: 'approval' }>).detail;

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

describe('agentInitials', () => {
  test('takes first letters of the first two words, uppercased', () => {
    expect(agentInitials('Growth agent')).toBe('GA');
    expect(agentInitials('Suna')).toBe('S');
    expect(agentInitials('  ')).toBe('AI');
    expect(agentInitials('')).toBe('AI');
  });
});

describe('mapApiReviewItem', () => {
  test('maps the envelope, derives actor + action labels, and normalizes detail', () => {
    const item = mapApiReviewItem(row, 'Acme Growth');
    expect(item.id).toBe('rv-1');
    expect(item.kind).toBe('output');
    expect(item.status).toBe('needs_you');
    expect(item.project).toBe('Acme Growth');
    expect(item.actor).toEqual({ name: 'Growth agent', initials: 'GA' });
    expect(item.primaryAction).toBe(PRIMARY_ACTION.output);
    expect(item.secondaryAction).toBe('Request changes');
    expect(item.detail).toMatchObject({
      artifactKind: 'page',
      artifactLabel: 'Landing page',
      note: 'Look before publish',
    });
  });

  test('falls back to a generic agent label when the row has none', () => {
    const item = mapApiReviewItem({ ...row, agent: '' }, 'P');
    expect(item.agent).toBe('Agent');
    expect(item.actor.initials).toBe('A');
  });

  // Regression: a Change Request arrives with the THIN adapter detail
  // (`{cr_id, base_ref, head_ref, description}`) — the modal's ChangeBody maps
  // over `whatChanged`/`verification`/`advanced.files`, so those must always be
  // arrays or the detail modal crashes ("Cannot read properties of undefined").
  test('normalizes a thin Change Request detail into a complete ChangeDetail', () => {
    const item = mapApiReviewItem(
      {
        ...row,
        kind: 'change',
        title: 'Refresh the pricing page',
        summary: '#7 · session/pricing → main',
        detail: {
          cr_id: 'cr-1',
          number: 7,
          base_ref: 'main',
          head_ref: 'session/pricing',
          description: 'Updated the copy\nTightened the CTA',
        },
      },
      'Acme',
    );
    expect(item.kind).toBe('change');
    // The opaque head branch is dropped from the row summary (kept in Advanced).
    expect(item.summary).toBe('#7 → main');
    const d = changeDetailOf(item);
    expect(d.whatChanged).toEqual(['Updated the copy', 'Tightened the CTA']);
    expect(Array.isArray(d.verification)).toBe(true);
    expect(d.advanced.baseRef).toBe('main');
    expect(d.advanced.headRef).toBe('session/pricing');
    expect(Array.isArray(d.advanced.files)).toBe(true);
  });

  test('a change with an empty detail still yields safe arrays (uses the summary)', () => {
    const item = mapApiReviewItem({ ...row, kind: 'change', summary: 'A change', detail: {} }, 'P');
    const d = changeDetailOf(item);
    expect(d.whatChanged).toEqual(['A change']);
    expect(d.verification).toEqual([]);
    expect(d.advanced.files).toEqual([]);
  });

  test('normalizes a thin executor-approval detail into a single humanized action', () => {
    const item = mapApiReviewItem(
      {
        ...row,
        kind: 'approval',
        title: 'Approve: gmail.messages.send',
        risk: 'high',
        // connector_id is an opaque UUID — the connector NAME comes from the path.
        detail: { execution_id: 'ex-1', action_path: 'gmail.messages.send', connector_id: 'uuid-x' },
      },
      'P',
    );
    // Row title is humanized from the tool path, not the raw `Approve: …`.
    expect(item.title).toBe('(Gmail) Messages Send');
    const d = approvalDetailOf(item);
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0]).toMatchObject({
      id: 'ex-1',
      title: '(Gmail) Messages Send',
      action: 'messages.send',
      connector: 'gmail',
      risk: 'high',
    });
  });

  test('approval description names the originating session when known', () => {
    const base: ApiReviewItem = {
      ...row,
      kind: 'approval',
      origin_session_id: 'sess-1',
      title: 'Approve: gmail.send_email',
      summary: 'gmail.send_email · awaiting approval',
      detail: { execution_id: 'ex-2', action_path: 'gmail.send_email', connector_id: 'uuid-y' },
    };
    // With the session label resolved, the description is the session's name.
    const named = mapApiReviewItem(base, 'P', { 'sess-1': 'Fix the login bug' });
    expect(named.title).toBe('(Gmail) Send Email');
    expect(named.summary).toBe('Fix the login bug');
    // Unknown label but a session id present → a neutral pointer, never the path.
    const unnamed = mapApiReviewItem(base, 'P');
    expect(unnamed.summary).toBe('From a running session');
    expect(unnamed.summary).not.toContain('gmail');
  });
});

describe('humanizeActionPath', () => {
  test('formats connector.action as (Connector) Title Case Action', () => {
    expect(humanizeActionPath('gmail.send_email')).toBe('(Gmail) Send Email');
    expect(humanizeActionPath('gmail.messages.send')).toBe('(Gmail) Messages Send');
    expect(humanizeActionPath('github.repos.delete')).toBe('(Github) Repos Delete');
  });

  test('a bare token with no connector prefix is just title-cased', () => {
    expect(humanizeActionPath('send_email')).toBe('Send Email');
    expect(humanizeActionPath('')).toBe('');
  });
});

describe('statusToVerdict', () => {
  test('maps terminal statuses to their verdict; waiting/needs_you have none', () => {
    expect(statusToVerdict('approved')).toBe('approve');
    expect(statusToVerdict('rejected')).toBe('reject');
    expect(statusToVerdict('changes_requested')).toBe('changes');
    expect(statusToVerdict('done')).toBe('answer');
    expect(statusToVerdict('dismissed')).toBe('dismiss');
    expect(statusToVerdict('waiting')).toBeNull();
    expect(statusToVerdict('needs_you')).toBeNull();
  });
});
