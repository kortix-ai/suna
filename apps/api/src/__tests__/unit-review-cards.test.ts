/**
 * Slack review-card rendering + action_id (de)serialization.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ReviewCardItem,
  buildReviewCardBlocks,
  parseReviewActionId,
  reviewActionId,
} from '../channels/slack/review-cards';

const item: ReviewCardItem = {
  review_item_id: 'rv-1',
  kind: 'output',
  risk: 'low',
  title: 'Review the landing page',
  summary: 'Built from the brief',
};

describe('reviewActionId / parseReviewActionId', () => {
  test('round-trips verb + id, including adapted ids with colons', () => {
    for (const id of ['rv-1', 'cr:abc-123', 'exec:def-456']) {
      const a = reviewActionId(id, 'approve');
      expect(parseReviewActionId(a)).toEqual({ verb: 'approve', id });
    }
    expect(parseReviewActionId(reviewActionId('rv-1', 'changes'))).toEqual({
      verb: 'changes',
      id: 'rv-1',
    });
  });
  test('rejects foreign or malformed action_ids', () => {
    expect(parseReviewActionId('qa_0_1')).toBeNull();
    expect(parseReviewActionId('review_')).toBeNull();
    expect(parseReviewActionId('review_bogus_rv-1')).toBeNull();
  });
});

describe('buildReviewCardBlocks', () => {
  test('renders a title/summary section + Approve/Deny/Ask-for-changes actions', () => {
    const blocks = buildReviewCardBlocks(item);
    const section = blocks.find((b) => b.type === 'section') as { text: { text: string } };
    expect(section.text.text).toContain('Review the landing page');
    expect(section.text.text).toContain('Built from the brief');

    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string; text: { text: string } }>;
    };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toContain(reviewActionId('rv-1', 'approve'));
    expect(ids).toContain(reviewActionId('rv-1', 'deny'));
    expect(ids).toContain(reviewActionId('rv-1', 'changes'));
    expect(actions.elements[0].text.text).toBe('Approve');
  });

  test('a change uses "Ship it"/"Reject"; a high-risk item adds a warning note', () => {
    const blocks = buildReviewCardBlocks({ ...item, kind: 'change', risk: 'high' });
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ text: { text: string } }>;
    };
    expect(actions.elements[0].text.text).toBe('Ship it');
    expect(actions.elements[1].text.text).toBe('Reject');
    const ctx = blocks.filter((b) => b.type === 'context') as Array<{
      elements: Array<{ text: string }>;
    }>;
    expect(ctx.some((c) => c.elements[0].text.includes('High-risk'))).toBe(true);
  });

  test('a decision omits the deny button (it needs an answer, not a yes/no)', () => {
    const blocks = buildReviewCardBlocks({ ...item, kind: 'decision' });
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string }>;
    };
    expect(actions.elements.some((e) => e.action_id.includes('_deny_'))).toBe(false);
    expect(actions.elements[0].action_id).toContain('_approve_');
  });

  test('includes a deep-link "View in Kortix" button when a webUrl is given', () => {
    const blocks = buildReviewCardBlocks(item, { webUrl: 'https://app.kortix.ai/x' });
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ url?: string; text: { text: string } }>;
    };
    const view = actions.elements.find((e) => e.text.text === 'View in Kortix');
    expect(view?.url).toBe('https://app.kortix.ai/x');
  });
});
