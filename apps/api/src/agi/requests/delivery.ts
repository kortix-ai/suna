/**
 * Getting a blocked unattended session's ask in front of a human (R-12g).
 *
 * This module builds NOTHING new. It reuses, in order, the surfaces the platform
 * already has:
 *
 *   1. a Slack direct message to the responder — the SAME four calls
 *      `notifyAdminsOfAccessRequest` makes (`loadSlackTokenForProject` →
 *      `lookupSlackUserIdForKortixUser` → `openDmChannel` → `postBlocks`). That
 *      path is live, in production, and already the way this platform reaches a
 *      specific person out of band with no live turn to reply into. An unattended
 *      07:00 push has no thread, which is exactly why `postQuestion` and
 *      `postReviewCard` cannot be used here: both open with `loadTurn` and are a
 *      no-op without one.
 *
 *   2. the durable request row itself, addressed to a named person and listed by
 *      `kortix tasks waiting` and the liveness route. Weaker — the human has to
 *      come looking — but it is a real surface with a real addressee, which is
 *      precisely what a session log is not.
 *
 * There is no third tier and no new transport. If a workspace has no members at
 * all there is nobody to tell, the request stays undelivered, and liveness
 * reports the task as stalled. That is the correct outcome: a system that cannot
 * reach anyone must say so rather than pretend.
 *
 * Everything here is BEST EFFORT with respect to Slack and NEVER with respect to
 * the record. A Slack outage degrades delivery to `inbox`; it does not lose the
 * ask and it does not fail the caller's request.
 */
import type { AgiRequestRow, DeliverySurface, RequestKind } from './wire';
import { requestBody, requestHeadline } from './wire';
import { config } from '../../config';

export interface DeliveryResult {
  /** The surface that accepted it. Null means nobody could be reached, which is
   *  a stall, not an error. */
  via: DeliverySurface | null;
  /** Why Slack was not used, when it was not. Diagnostic only — a caller must
   *  never branch on it, because "no Slack" is a normal state. */
  slackSkipped: 'no_install' | 'no_identity' | 'post_failed' | null;
}

/**
 * The entire Slack surface this module touches, as an explicit seam.
 *
 * Production passes nothing and gets {@link REAL_SLACK}. It exists so the tests
 * can drive the DM branch — which cannot otherwise run anywhere without a live
 * Slack workspace — WITHOUT `mock.module`. Module mocking would be the obvious
 * choice and is the wrong one here: replacing `channels/*` for one file leaks
 * into every other file in the same bun process, and spreading the real modules
 * to avoid that drags `shared/db` into this file's import graph, where another
 * file's incomplete mock of it decides whether these tests pass. A four-function
 * parameter has neither problem, and it documents the dependency besides.
 */
export interface SlackTransport {
  loadToken: (projectId: string) => Promise<string | null>;
  loadInstall: (projectId: string) => Promise<{ workspaceId: string } | null>;
  lookupUserId: (teamId: string, userId: string) => Promise<string | null>;
  openDm: (token: string, slackUserId: string) => Promise<string | null>;
  post: (
    token: string,
    channel: string,
    text: string,
    blocks: unknown[],
  ) => Promise<string | null>;
}

/**
 * The real transport, resolved LAZILY.
 *
 * `channels/*` is imported inside each call rather than at module scope so that
 * importing this module costs nothing but `./wire` and `config`. Two reasons,
 * both real:
 *
 *   • the Slack stack (and, transitively, the database client) is loaded only
 *     when an ask actually has to be delivered, which is rare;
 *   • it keeps this module — and anything that imports it, including the AGI
 *     route graph — off the `shared/db` import chain that several test files in
 *     this repo replace incompletely.
 *
 * `loadSlackInstall` reads scope-agnostically: Slack credentials are stored with
 * scope='connector', which `listProjectSecrets` deliberately drops. Going
 * through the install helper is what keeps this off the same rake the "Not
 * connected" bug stepped on.
 */
export const REAL_SLACK: SlackTransport = {
  loadToken: async (projectId) =>
    (await import('../../channels/install-store')).loadSlackTokenForProject(projectId),
  loadInstall: async (projectId) =>
    (await import('../../channels/install-store')).loadSlackInstall(projectId),
  lookupUserId: async (teamId, userId) =>
    (await import('../../channels/slack/identity')).lookupSlackUserIdForKortixUser(teamId, userId),
  openDm: async (token, slackUserId) =>
    (await import('../../channels/slack-api')).openDmChannel(token, slackUserId),
  post: async (token, channel, text, blocks) =>
    (await import('../../channels/slack-api')).postBlocks(token, channel, text, blocks),
};

/**
 * Deliver one request. Called once, immediately after the row is created, and
 * NEVER on a fingerprint dedupe — a repeat ask must not become a repeat DM.
 */
export async function deliverRequest(input: {
  workspaceId: string;
  request: AgiRequestRow;
  taskTitle: string;
  slack?: SlackTransport;
}): Promise<DeliveryResult> {
  // No addressee means no delivery, full stop. The delivery-addressed CHECK
  // would refuse the write anyway; short-circuiting here keeps the Slack calls
  // from running for a message that has nowhere to go.
  if (!input.request.responderUserId) return { via: null, slackSkipped: null };

  const slack = await postSlackDm({
    workspaceId: input.workspaceId,
    responderUserId: input.request.responderUserId,
    request: input.request,
    taskTitle: input.taskTitle,
    transport: input.slack ?? REAL_SLACK,
  }).catch((err) => {
    // A Slack failure may never cost us the ask. Degrade to the inbox.
    console.warn('[agi/requests] slack delivery threw', {
      requestId: input.request.requestId,
      err: (err as Error)?.message,
    });
    return { ok: false as const, skipped: 'post_failed' as const };
  });

  if (slack.ok) return { via: 'slack', slackSkipped: null };
  return { via: 'inbox', slackSkipped: slack.skipped };
}

type SlackOutcome =
  | { ok: true }
  | { ok: false; skipped: 'no_install' | 'no_identity' | 'post_failed' };

async function postSlackDm(input: {
  workspaceId: string;
  responderUserId: string;
  request: AgiRequestRow;
  taskTitle: string;
  transport: SlackTransport;
}): Promise<SlackOutcome> {
  const slack = input.transport;
  const [token, install] = await Promise.all([
    slack.loadToken(input.workspaceId),
    slack.loadInstall(input.workspaceId),
  ]);
  if (!token || !install?.workspaceId) return { ok: false, skipped: 'no_install' };
  const teamId = install.workspaceId;

  // The responder must have linked their Kortix account to a Slack identity in
  // THIS workspace. Without it there is no user to open a DM with — an
  // unlinked admin still sees the ask in `kortix tasks waiting`, which is the
  // same fallback notifyAdminsOfAccessRequest relies on.
  const slackUserId = await slack.lookupUserId(teamId, input.responderUserId);
  if (!slackUserId) return { ok: false, skipped: 'no_identity' };

  const dm = await slack.openDm(token, slackUserId);
  if (!dm) return { ok: false, skipped: 'post_failed' };

  const kind = input.request.kind as RequestKind;
  const fallback = requestHeadline({ kind, need: input.request.need });
  const text = requestBody({
    kind,
    need: input.request.need,
    why: input.request.why,
    url: input.request.url,
    taskId: input.request.taskId,
    taskTitle: input.taskTitle,
    sessionId: input.request.requestedBySessionId,
  });

  const ts = await slack.post(token, dm, fallback, buildBlocks({ text, request: input.request }));
  return ts ? { ok: true } : { ok: false, skipped: 'post_failed' };
}

/**
 * The DM's Block Kit body: the ask as text, plus at most two buttons.
 *
 * Deliberately link buttons, not `action_id` buttons. An action button would
 * need an interactivity handler, a verdict path, and a way to resume a session
 * that is long gone — a whole second approval subsystem. A link button opens the
 * minted form or the task in Kortix, where the existing surfaces take over. That
 * keeps this module a delivery, not a workflow.
 */
function buildBlocks(input: { text: string; request: AgiRequestRow }): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: input.text } },
  ];

  const elements: unknown[] = [];
  if (input.request.url) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Supply it', emoji: true },
      style: 'primary',
      url: input.request.url,
      action_id: 'agi_request_supply',
    });
  }
  const taskUrl = taskWebUrl(input.request.workspaceId);
  if (taskUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open in Kortix', emoji: true },
      url: taskUrl,
      action_id: 'agi_request_open',
    });
  }
  if (elements.length > 0) blocks.push({ type: 'actions', elements });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Nothing is running on this until you act. Close it with \`kortix tasks answer ${input.request.requestId}\`.`,
      },
    ],
  });
  return blocks;
}

/** The dashboard, never the API host — `$KORTIX_API_URL` is not browsable. */
function taskWebUrl(workspaceId: string): string | null {
  const base = (config.FRONTEND_URL || '').replace(/\/+$/, '');
  return base ? `${base}/projects/${workspaceId}` : null;
}
