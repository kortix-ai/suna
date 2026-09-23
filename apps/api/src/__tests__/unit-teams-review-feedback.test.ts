import { describe, expect, test } from 'bun:test';

import { REVIEW_FEEDBACK_INPUT, buildReviewCard } from '../channels/teams/cards';

// `handleReview` called `applyVerdict(..., { feedback: null })` unconditionally,
// so `review_items.feedback` — a column that has always existed — was never
// filled by either channel, and the agent was told to "ask what to change",
// asking the reviewer for something they already knew when they clicked.

const card = (risk = 'high') =>
  buildReviewCard({
    reviewItemId: 'ri_1',
    title: 'Delete the staging bucket',
    summary: 'Removes 400 objects',
    risk,
    viewUrl: 'https://dev.kortix.com/x',
  }) as unknown as { body: Array<Record<string, any>>; actions: Array<Record<string, any>> };

describe('buildReviewCard — the reviewer can say why', () => {
  test('carries one optional multiline box', () => {
    const inputs = card().body.filter((b) => b.type === 'Input.Text');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].id).toBe(REVIEW_FEEDBACK_INPUT);
    expect(inputs[0].isMultiline).toBe(true);
    // Optional: a required box would block a plain Approve behind typing.
    expect(inputs[0].isRequired).toBeUndefined();
  });

  test('one box serves all three verdicts', () => {
    // `Action.Execute` returns every input whichever button was pressed, so
    // feedback rides along with Approve and Deny too, not only "changes".
    const c = card();
    expect(c.actions.map((a) => a.title)).toEqual(['Approve', 'Request changes', 'Deny', 'View in Kortix']);
    for (const a of c.actions.filter((x) => x.verb === 'teams_review')) {
      expect(a.data.reviewItemId).toBe('ri_1');
    }
    expect(c.body.filter((b) => b.type === 'Input.Text')).toHaveLength(1);
  });

  test('the input id cannot collide with the action data keys', () => {
    // A collision would let the typed value overwrite the verdict.
    const keys = new Set(card().actions.flatMap((a) => Object.keys(a.data ?? {})));
    expect(keys.has(REVIEW_FEEDBACK_INPUT)).toBe(false);
  });

  test('the risk chip still renders, and is dropped when there is no risk', () => {
    expect(JSON.stringify(card('high'))).toContain('Risk · high');
    expect(JSON.stringify(card('none'))).not.toContain('Risk ·');
  });
});
