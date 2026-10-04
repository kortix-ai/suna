/**
 * The "Request changes" modal.
 *
 * `applyVerdict` has always accepted `feedback`, and `review_items.feedback`
 * has always existed — neither channel ever filled it. So "Request changes"
 * sent the agent the line "Ask what to change, then revise", asking the
 * reviewer for something they already knew when they clicked, one round trip
 * later.
 *
 * Teams could solve it with a box on the card itself, because an Adaptive Card
 * returns every input with whichever button was pressed. Slack has no such
 * affordance: Block Kit inputs on a posted message do not ride along with a
 * button, so collecting typed input needs `views.open` and a `view_submission`
 * round trip. That is why only the verdict that NEEDS a reason opens a modal —
 * Approve and Deny stay one click, as they are.
 *
 * Pure and Slack-free so the shapes and the parsing are unit-tested in
 * isolation.
 */

export const REVIEW_FEEDBACK_CALLBACK = 'review_changes_feedback';
const FEEDBACK_BLOCK = 'feedback_block';
const FEEDBACK_ACTION = 'feedback_input';

/** What the modal has to carry across the round trip to apply the verdict. */
export interface ReviewFeedbackMetadata {
  reviewItemId: string;
  projectId: string;
  teamId: string;
  threadTs: string;
  /** A `view_submission` payload carries NO channel and NO message, so the
   *  coordinates the agent's follow-up turn needs have to travel here. */
  channelId: string;
  messageTs: string;
  responseUrl?: string;
}

/**
 * Slack caps `private_metadata` at 3000 characters and hands it back verbatim.
 * It is NOT a trust boundary — the submit path re-resolves the item and
 * re-authorizes the actor rather than believing any of this.
 */
export function encodeReviewMetadata(meta: ReviewFeedbackMetadata): string {
  return JSON.stringify(meta).slice(0, 3000);
}

export function decodeReviewMetadata(raw: string | undefined): ReviewFeedbackMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewFeedbackMetadata>;
    if (
      !parsed.reviewItemId ||
      !parsed.projectId ||
      !parsed.teamId ||
      !parsed.threadTs ||
      !parsed.channelId ||
      !parsed.messageTs
    ) {
      return null;
    }
    return {
      reviewItemId: parsed.reviewItemId,
      projectId: parsed.projectId,
      teamId: parsed.teamId,
      threadTs: parsed.threadTs,
      channelId: parsed.channelId,
      messageTs: parsed.messageTs,
      responseUrl: typeof parsed.responseUrl === 'string' ? parsed.responseUrl : undefined,
    };
  } catch {
    return null;
  }
}

export function buildReviewFeedbackView(opts: {
  title: string;
  metadata: ReviewFeedbackMetadata;
}): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: REVIEW_FEEDBACK_CALLBACK,
    private_metadata: encodeReviewMetadata(opts.metadata),
    // Slack rejects a modal title over 24 characters outright, which would
    // make the button do nothing at all.
    title: { type: 'plain_text', text: 'Request changes' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${opts.title.slice(0, 200)}*` },
      },
      {
        type: 'input',
        block_id: FEEDBACK_BLOCK,
        // Optional: someone who just wants to bounce it back should not be
        // blocked behind a required field. The prompt is the nudge.
        optional: true,
        label: { type: 'plain_text', text: 'What should change?' },
        element: {
          type: 'plain_text_input',
          action_id: FEEDBACK_ACTION,
          multiline: true,
          max_length: 2000,
          placeholder: { type: 'plain_text', text: 'Sent to the agent with your decision' },
        },
      },
    ],
  };
}

/** The typed feedback, or null when the reviewer submitted an empty box. */
export function readReviewFeedback(view: {
  state?: { values?: Record<string, Record<string, { value?: string | null }>> };
}): string | null {
  const raw = view?.state?.values?.[FEEDBACK_BLOCK]?.[FEEDBACK_ACTION]?.value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 2000) : null;
}
