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
}

export interface StreamTextChunk {
  type: 'markdown_text';
  text: string;
}

// A stream chunk — a plan checkpoint or a piece of answer text. The answer
// must ride as a `markdown_text` chunk: chat.stopStream rejects a top-level
// `markdown_text` param alongside `chunks`.
export type StreamChunk = StreamTaskChunk | StreamTextChunk;

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

export async function appendStream(
  token: string,
  channel: string,
  ts: string,
  chunks: StreamChunk[],
): Promise<void> {
  try {
    const r = await slackApiCall(token, 'chat.appendStream', { channel, ts, chunks });
    if (!r.ok) console.warn('[slack-api] chat.appendStream failed', { error: r.error });
  } catch (err) {
    console.warn('[slack-api] chat.appendStream error', err);
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
    const r = await slackApiCall(token, 'chat.stopStream', { channel, ts, chunks });
    // A watchdog stop can race the agent's own stop — ignore "already stopped".
    if (!r.ok && r.error !== 'message_not_streaming' && r.error !== 'cant_update_message') {
      console.warn('[slack-api] chat.stopStream failed', { error: r.error });
    }
  } catch (err) {
    console.warn('[slack-api] chat.stopStream error', err);
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
