const SLACK_API_BASE = 'https://slack.com/api';

interface SlackApiResult {
  ok: boolean;
  error?: string;
  ts?: string;
  [key: string]: unknown;
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackApiResult> {
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as SlackApiResult;
}

// Posts a plain message. Returns the message ts (needed to delete it later).
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string | null> {
  try {
    const r = await slackApiCall(token, 'chat.postMessage', {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    if (!r.ok) {
      console.warn('[slack-api] chat.postMessage failed', { error: r.error });
      return null;
    }
    return typeof r.ts === 'string' ? r.ts : null;
  } catch (err) {
    console.warn('[slack-api] chat.postMessage error', err);
    return null;
  }
}

// Posts a Block Kit message and returns its ts (needed to edit it later).
export async function postBlocks(
  token: string,
  channel: string,
  text: string,
  blocks: unknown[],
  threadTs?: string,
): Promise<string | null> {
  try {
    const r = await slackApiCall(token, 'chat.postMessage', {
      channel,
      text,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    if (!r.ok) {
      console.warn('[slack-api] postBlocks failed', { error: r.error });
      return null;
    }
    return typeof r.ts === 'string' ? r.ts : null;
  } catch (err) {
    console.warn('[slack-api] postBlocks error', err);
    return null;
  }
}

export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  try {
    const r = await slackApiCall(token, 'chat.update', { channel, ts, text, blocks: [] });
    if (!r.ok) console.warn('[slack-api] chat.update failed', { error: r.error });
  } catch (err) {
    console.warn('[slack-api] chat.update error', err);
  }
}

export async function updateBlocks(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks: unknown[],
): Promise<void> {
  try {
    const r = await slackApiCall(token, 'chat.update', { channel, ts, text, blocks });
    if (!r.ok) console.warn('[slack-api] chat.update (blocks) failed', { error: r.error });
  } catch (err) {
    console.warn('[slack-api] chat.update (blocks) error', err);
  }
}

export async function deleteMessage(token: string, channel: string, ts: string): Promise<void> {
  try {
    const r = await slackApiCall(token, 'chat.delete', { channel, ts });
    if (!r.ok && r.error !== 'message_not_found') {
      console.warn('[slack-api] chat.delete failed', { error: r.error });
    }
  } catch (err) {
    console.warn('[slack-api] chat.delete error', err);
  }
}

// chat.startStream requires the bot to be a member of the channel — posting
// via chat:write.public is not enough. Join is idempotent (already-a-member
// is `ok: true`). Returns false for private channels / DMs where join isn't
// applicable; callers should treat that as non-fatal.
export async function joinChannel(token: string, channel: string): Promise<boolean> {
  try {
    const r = await slackApiCall(token, 'conversations.join', { channel });
    if (r.ok) return true;
    // method_not_supported_for_channel_type → DM or private; nothing to join.
    // already_in_channel → still a member, treat as success.
    if (r.error === 'already_in_channel') return true;
    if (r.error !== 'method_not_supported_for_channel_type') {
      console.warn('[slack-api] conversations.join failed', { error: r.error, channel });
    }
    return false;
  } catch (err) {
    console.warn('[slack-api] conversations.join error', err);
    return false;
  }
}

export async function addReaction(
  token: string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    const r = await slackApiCall(token, 'reactions.add', { channel, timestamp, name });
    if (!r.ok && r.error !== 'already_reacted') {
      console.warn('[slack-api] reactions.add failed', { error: r.error });
    }
  } catch (err) {
    console.warn('[slack-api] reactions.add error', err);
  }
}

export async function removeReaction(
  token: string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  try {
    const r = await slackApiCall(token, 'reactions.remove', { channel, timestamp, name });
    if (!r.ok && r.error !== 'no_reaction') {
      console.warn('[slack-api] reactions.remove failed', { error: r.error });
    }
  } catch (err) {
    console.warn('[slack-api] reactions.remove error', err);
  }
}

// ─── Streaming (chat.startStream / appendStream / stopStream) ────────────────
// Renders a live plan block in a channel thread. task_update chunks are the
// plan checkpoints; markdown_text is the final answer body.
export type StreamTaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface StreamTaskChunk {
  type: 'task_update';
  id: string;
  title: string;
  status: StreamTaskStatus;
  // Optional inline rich text. Slack accepts these as plain strings on the
  // streaming chunk and auto-wraps them into rich_text blocks server-side.
  // `details` renders as the subtitle line under the task title (visible while
  // in_progress); `output` renders as the bullet line shown after completion.
  // Note: re-sending these for the same task_id APPENDS rather than replaces
  // — only set them once per task_id.
  details?: string;
  output?: string;
  // Citation footer rendered under the task card. Plain-string `details`
  // and `output` accept `<url|text>` mrkdwn for inline links; `sources` is
  // the dedicated, structured citation list.
  sources?: Array<{ type: 'url'; url: string; text: string }>;
}

export interface StreamTextChunk {
  type: 'markdown_text';
  text: string;
}

// Updates the plan's title line. Also doubles as the keepalive heartbeat:
// Slack auto-completes a stream after a few minutes without appends (painting
// "Something went wrong" + an error badge on the in-progress task), so we
// re-append the same title periodically to reset its inactivity timer without
// changing what the user sees.
export interface StreamPlanUpdateChunk {
  type: 'plan_update';
  title: string;
}

// Full Block Kit closing chunk — use for rich answers (headers, sections,
// images, context actions). Slack validates these against the standard
// Block Kit schema. Only valid as a closing chunk on chat.stopStream.
export interface StreamBlocksChunk {
  type: 'blocks';
  blocks: unknown[];
}

// A stream chunk — a plan checkpoint, a plan title update, a piece of answer
// text, or a full Block Kit blocks payload. The answer must ride as
// `markdown_text` OR `blocks` — chat.stopStream rejects top-level text
// alongside `chunks`.
export type StreamChunk = StreamTaskChunk | StreamTextChunk | StreamPlanUpdateChunk | StreamBlocksChunk;

export async function startStream(
  token: string,
  channel: string,
  threadTs: string,
  recipientUserId: string,
  recipientTeamId: string,
  chunks: StreamChunk[],
): Promise<string | null> {
  try {
    const r = await slackApiCall(token, 'chat.startStream', {
      channel,
      thread_ts: threadTs,
      recipient_user_id: recipientUserId,
      recipient_team_id: recipientTeamId,
      task_display_mode: 'plan',
      chunks,
    });
    if (!r.ok) {
      console.warn('[slack-api] chat.startStream failed', { error: r.error });
      return null;
    }
    return typeof r.ts === 'string' ? r.ts : null;
  } catch (err) {
    console.warn('[slack-api] chat.startStream error', err);
    return null;
  }
}

// Returns ok:false with the Slack error so callers can recover — the critical
// case is `message_not_streaming`: Slack auto-completed the stream after an
// inactivity window, and every further append silently vanishes unless the
// caller falls back to chat.update on the (now plain) message.
export async function appendStream(
  token: string,
  channel: string,
  ts: string,
  chunks: StreamChunk[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await slackApiCall(token, 'chat.appendStream', { channel, ts, chunks });
    if (!r.ok) console.warn('[slack-api] chat.appendStream failed', { error: r.error });
    return { ok: r.ok, error: r.error };
  } catch (err) {
    console.warn('[slack-api] chat.appendStream error', err);
    return { ok: false, error: (err as Error).message };
  }
}

// Finalize a stream. The closing chunks carry the last checkpoint state and the
// answer as a `markdown_text` chunk.
export async function stopStream(
  token: string,
  channel: string,
  ts: string,
  chunks: StreamChunk[],
): Promise<void> {
  try {
    // A bare stop (no chunks) is valid — used for the silent close when the
    // turn ended with nothing left to say.
    const r = await slackApiCall(token, 'chat.stopStream', {
      channel,
      ts,
      ...(chunks.length > 0 ? { chunks } : {}),
    });
    // A watchdog stop can race the agent's own stop — ignore "already stopped".
    if (!r.ok && r.error !== 'message_not_streaming' && r.error !== 'cant_update_message') {
      console.warn('[slack-api] chat.stopStream failed', { error: r.error });
    }
  } catch (err) {
    console.warn('[slack-api] chat.stopStream error', err);
  }
}

// Publish a Block Kit view to a user's App Home tab. View shape:
//   { type: 'home', blocks: [...Block Kit blocks] }
export async function publishHomeView(
  token: string,
  userId: string,
  view: Record<string, unknown>,
): Promise<boolean> {
  try {
    const r = await slackApiCall(token, 'views.publish', { user_id: userId, view });
    if (!r.ok) {
      console.warn('[slack-api] views.publish failed', { error: r.error, user_id: userId });
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[slack-api] views.publish error', err);
    return false;
  }
}

export async function getChannelName(token: string, channel: string): Promise<string | null> {
  try {
    const r = await slackApiCall(token, 'conversations.info', { channel });
    if (!r.ok) return null;
    const info = r.channel as { name?: string } | undefined;
    return info?.name ?? null;
  } catch {
    return null;
  }
}
