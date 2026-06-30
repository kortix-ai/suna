/**
 * Slack review cards — render a Review Center item as a Block Kit message so a
 * human can act on it from a thread, mirroring the question-card pattern
 * (questions.ts `buildQuestionBlocks`). The buttons carry an action_id of the
 * form `review_<verb>_<reviewItemId>`; the interactivity handler parses it and
 * resumes the agent via the same `spawnAgentTurn` path questions use.
 *
 * This module is the pure rendering + id (de)serialization half — unit-tested.
 * The handler wiring (handleReviewAction) is a thin follow-up that reuses the
 * existing question→resume dispatch. See docs/REVIEW_CENTER_DESIGN.md.
 */

export type ReviewVerb = 'approve' | 'deny' | 'changes' | 'view';

export interface ReviewCardItem {
  review_item_id: string;
  kind: 'change' | 'approval' | 'output' | 'decision' | 'batch';
  risk: 'none' | 'low' | 'medium' | 'high';
  title: string;
  summary: string;
}

const ACTION_PREFIX = 'review_';
const VERBS: readonly ReviewVerb[] = ['approve', 'deny', 'changes', 'view'];

/** action_id carrying the verb + which item it targets. */
export function reviewActionId(reviewItemId: string, verb: ReviewVerb): string {
  return `${ACTION_PREFIX}${verb}_${reviewItemId}`;
}

/** Parse a `review_<verb>_<id>` action_id back into its parts (null if not ours). */
export function parseReviewActionId(actionId: string): { verb: ReviewVerb; id: string } | null {
  if (!actionId.startsWith(ACTION_PREFIX)) return null;
  const rest = actionId.slice(ACTION_PREFIX.length);
  const underscore = rest.indexOf('_');
  if (underscore < 0) return null;
  const verb = rest.slice(0, underscore) as ReviewVerb;
  const id = rest.slice(underscore + 1);
  if (!VERBS.includes(verb) || !id) return null;
  return { verb, id };
}

/**
 * Map a card verb to the review `verdict` the act path applies. `view` is a link
 * button (it opens Kortix), so it carries no verdict and returns null.
 */
export function reviewVerbToVerdict(verb: ReviewVerb): 'approve' | 'reject' | 'changes' | null {
  if (verb === 'approve') return 'approve';
  if (verb === 'deny') return 'reject';
  if (verb === 'changes') return 'changes';
  return null;
}

/** Minimal Slack mrkdwn escaping (matches the question-card treatment). */
function escapeMrkdwn(s: string): string {
  return s.replace(/[*_~`]/g, (c) => `\\${c}`);
}

/** The primary CTA label per kind, in plain language. */
function primaryLabel(kind: ReviewCardItem['kind']): string {
  if (kind === 'change') return 'Ship it';
  if (kind === 'decision') return 'Answer';
  return 'Approve';
}

/**
 * Build the Block Kit blocks for a review item: a title/summary section, an
 * optional risk note, and an actions row (Approve/Deny/Ask-for-changes + an
 * optional deep link to the web center).
 */
export function buildReviewCardBlocks(
  item: ReviewCardItem,
  opts: { webUrl?: string } = {},
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeMrkdwn(item.title)}*\n${escapeMrkdwn(item.summary)}`,
      },
    },
  ];

  const riskNote =
    item.risk === 'high'
      ? '⚠️  High-risk — has a real-world effect'
      : item.risk === 'medium'
        ? 'Medium-risk action'
        : null;
  if (riskNote) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: riskNote }] });
  }

  const elements: Array<Record<string, unknown>> = [
    {
      type: 'button',
      style: 'primary',
      text: { type: 'plain_text', text: primaryLabel(item.kind), emoji: true },
      action_id: reviewActionId(item.review_item_id, 'approve'),
      value: item.review_item_id,
    },
  ];
  if (item.kind !== 'decision') {
    elements.push({
      type: 'button',
      style: 'danger',
      text: { type: 'plain_text', text: item.kind === 'change' ? 'Reject' : 'Deny' },
      action_id: reviewActionId(item.review_item_id, 'deny'),
      value: item.review_item_id,
    });
  }
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Ask for changes' },
    action_id: reviewActionId(item.review_item_id, 'changes'),
    value: item.review_item_id,
  });
  if (opts.webUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View in Kortix' },
      action_id: reviewActionId(item.review_item_id, 'view'),
      url: opts.webUrl,
    });
  }
  blocks.push({ type: 'actions', elements });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '↩︎  Click a button, or reply in this thread.' }],
  });
  return blocks;
}
