import { describe, expect, test } from 'bun:test';

import {
  REVIEW_FEEDBACK_CALLBACK,
  buildReviewFeedbackView,
  decodeReviewMetadata,
  encodeReviewMetadata,
  readReviewFeedback,
} from '../channels/slack/review-modal';

// `applyVerdict` has always accepted `feedback` and `review_items.feedback` has
// always existed — neither channel ever filled it. "Request changes" sent the
// agent "Ask what to change, then revise", asking the reviewer for what they
// knew when they clicked. Teams could use a box on the card; Slack cannot, so
// this is the modal round trip.

const META = {
  reviewItemId: 'ri_1',
  projectId: 'proj-1',
  teamId: 'T1',
  threadTs: '10.10',
  channelId: 'C1',
  messageTs: '11.11',
  responseUrl: 'https://hooks.slack.test/x',
};

describe('the modal Slack opens', () => {
  const view = buildReviewFeedbackView({ title: 'Delete the staging bucket', metadata: META }) as any;

  test('is a modal Slack will route back to us', () => {
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(REVIEW_FEEDBACK_CALLBACK);
  });

  test('keeps the title inside Slack`s 24-character cap', () => {
    // Slack rejects a longer modal title outright, which would make the button
    // appear to do nothing at all.
    expect(String(view.title.text).length).toBeLessThanOrEqual(24);
  });

  test('shows which review is being sent back', () => {
    expect(JSON.stringify(view.blocks)).toContain('Delete the staging bucket');
  });

  test('the box is optional and multiline', () => {
    const input = view.blocks.find((b: any) => b.type === 'input');
    // Required would put typing in front of someone who just wants to bounce
    // it back; the prompt is the nudge.
    expect(input.optional).toBe(true);
    expect(input.element.multiline).toBe(true);
    expect(input.element.max_length).toBe(2000);
  });

  test('carries the coordinates a view_submission does not have', () => {
    // A `view_submission` payload has no channel and no message, so the
    // agent`s follow-up turn could not be threaded without these.
    const back = decodeReviewMetadata(view.private_metadata)!;
    expect(back).toEqual(META);
  });
});

describe('metadata round trip', () => {
  test('survives encode → decode intact', () => {
    expect(decodeReviewMetadata(encodeReviewMetadata(META))).toEqual(META);
  });

  test('stays inside Slack`s 3000-character private_metadata cap', () => {
    const huge = { ...META, reviewItemId: 'x'.repeat(5000) };
    expect(encodeReviewMetadata(huge).length).toBeLessThanOrEqual(3000);
  });

  test('rejects anything missing a coordinate rather than half-applying', () => {
    for (const key of ['reviewItemId', 'projectId', 'teamId', 'threadTs', 'channelId', 'messageTs']) {
      const partial: Record<string, unknown> = { ...META };
      delete partial[key];
      expect(decodeReviewMetadata(JSON.stringify(partial)), key).toBeNull();
    }
  });

  test('rejects garbage and absence without throwing', () => {
    expect(decodeReviewMetadata('not json')).toBeNull();
    expect(decodeReviewMetadata('')).toBeNull();
    expect(decodeReviewMetadata(undefined)).toBeNull();
  });

  test('drops a non-string responseUrl instead of passing it on', () => {
    const decoded = decodeReviewMetadata(JSON.stringify({ ...META, responseUrl: 42 }));
    expect(decoded!.responseUrl).toBeUndefined();
  });
});

describe('reading what the reviewer typed', () => {
  const withValue = (value: unknown) => ({
    state: { values: { feedback_block: { feedback_input: { value: value as string } } } },
  });

  test('returns the trimmed note', () => {
    expect(readReviewFeedback(withValue('  rename the flag  '))).toBe('rename the flag');
  });

  test('an empty or whitespace box is null, not an empty string', () => {
    // `applyVerdict` stores null for "no feedback"; '' would look like a note.
    for (const v of ['', '   ', '\n\t ']) expect(readReviewFeedback(withValue(v))).toBeNull();
  });

  test('a missing block, a null value, or an empty view are all null', () => {
    expect(readReviewFeedback(withValue(null))).toBeNull();
    expect(readReviewFeedback({ state: { values: {} } })).toBeNull();
    expect(readReviewFeedback({})).toBeNull();
  });

  test('caps the note at the length the column and the prompt expect', () => {
    expect(readReviewFeedback(withValue('x'.repeat(5000)))!.length).toBe(2000);
  });
});
