import { describe, expect, test } from 'bun:test';
import type { ApiReviewItem } from '@/lib/projects-client';
import { PRIMARY_ACTION, agentInitials, mapApiReviewItem, statusToVerdict } from './map';

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
  test('maps the envelope, derives actor + action labels, and passes detail through', () => {
    const item = mapApiReviewItem(row, 'Acme Growth');
    expect(item.id).toBe('rv-1');
    expect(item.kind).toBe('output');
    expect(item.status).toBe('needs_you');
    expect(item.project).toBe('Acme Growth');
    expect(item.actor).toEqual({ name: 'Growth agent', initials: 'GA' });
    expect(item.primaryAction).toBe(PRIMARY_ACTION.output);
    expect(item.secondaryAction).toBe('Request changes');
    expect(item.detail).toEqual(row.detail);
  });

  test('falls back to a generic agent label when the row has none', () => {
    const item = mapApiReviewItem({ ...row, agent: '' }, 'P');
    expect(item.agent).toBe('Agent');
    expect(item.actor.initials).toBe('A');
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
