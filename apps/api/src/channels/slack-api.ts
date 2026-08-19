const SLACK_API_BASE = 'https://slack.com/api';

interface SlackApiResult {
  ok: boolean;
  error?: string;
  ts?: string;
  [key: string]: unknown;
}

// Slack errors (ok:false) that are transient and worth retrying. A permanent
// error (channel_not_found, not_in_channel, invalid_blocks, …) is returned
// immediately so the caller can fall back instead of hammering a doomed call.
const TRANSIENT_SLACK_ERRORS = new Set([
  'ratelimited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  opts: { retries?: number; idempotent?: boolean } = {},
): Promise<SlackApiResult> {
  // `idempotent` (default true) controls whether ambiguous failures are retried.
  // A 429 is ALWAYS safe to retry — Slack guarantees the request wasn't processed
  // — but a 5xx / timeout / network error on a non-idempotent WRITE
  // (chat.postMessage, chat.startStream) may have already landed, so retrying it
  // would duplicate the message. chat.update / reactions.* are idempotent and
  // retry freely.
  const idempotent = opts.idempotent !== false;
  const maxAttempts = Math.max(1, (opts.retries ?? 1) + 1);
  let last: SlackApiResult = { ok: false, error: 'unknown' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) {
        // Rate-limited → not processed → always safe to retry (honor Retry-After).
        const retryAfter = Number(res.headers.get('retry-after')) || attempt;
        last = { ok: false, error: 'ratelimited' };
        if (attempt < maxAttempts) {
          await sleep(Math.min(retryAfter, 5) * 1000);
          continue;
        }
        return last;
      }
      if (res.status >= 500) {
        last = { ok: false, error: `http_${res.status}` };
        // May have been processed server-side — only retry idempotent calls.
        if (idempotent && attempt < maxAttempts) {
          await sleep(attempt * 400);
          continue;
        }
        return last;
      }
      const data = (await res.json()) as SlackApiResult;
      if (!data.ok && attempt < maxAttempts) {
        const err = data.error ?? '';
        // 'ratelimited' is always safe; other transient errors only for idempotent.
        if (err === 'ratelimited' || (idempotent && TRANSIENT_SLACK_ERRORS.has(err))) {
          await sleep(attempt * 400);
          continue;
        }
      }
      return data;
    } catch (err) {
      // A timeout may mean the write succeeded slowly; a network error may not
      // have been sent. Either way, only retry idempotent calls.
      last = { ok: false, error: (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'network_error' };
      if (idempotent && attempt < maxAttempts) {
        await sleep(attempt * 400);
        continue;
      }
      return last;
    }
  }
  return last;
}

// Posts a plain message. Returns the message ts (needed to delete it later).
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string | null> {
  try {
    const r = await slackApiCall(
      token,
      'chat.postMessage',
      { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
      { idempotent: false }, // a write — don't retry an ambiguous 5xx/timeout into a duplicate
    );
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

// Opens (or returns) the bot's DM channel with a user so we can message them
// directly — a real DM notifies and persists, unlike an ephemeral. Returns the
// IM channel id, or null on failure.
export async function openDmChannel(token: string, userId: string): Promise<string | null> {
  try {
    const r = await slackApiCall(token, 'conversations.open', { users: userId });
    if (!r.ok) {
      console.warn('[slack-api] conversations.open failed', { error: r.error });
      return null;
    }
    const ch = r.channel as { id?: string } | undefined;
    return ch?.id ?? null;
  } catch (err) {
    console.warn('[slack-api] conversations.open error', err);
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
    const r = await slackApiCall(
      token,
      'chat.postMessage',
      { channel, text, blocks, ...(threadTs ? { thread_ts: threadTs } : {}) },
      { idempotent: false }, // a write — don't retry an ambiguous 5xx/timeout into a duplicate
    );
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

// Post a message visible ONLY to `user`, in-channel (and in-thread when
// `threadTs` is set). Used for the identity/access nudges so they appear right
// where the user @-mentioned Kortix instead of in a separate DM. Returns whether
// it landed. Note: an ephemeral cannot be edited by ts later — to update it after
// a button click, respond via the interaction's response_url.
export async function postEphemeral(
  token: string,
  channel: string,
  user: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string,
): Promise<boolean> {
  try {
    const r = await slackApiCall(
      token,
      'chat.postEphemeral',
      {
        channel,
        user,
        text,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
      { idempotent: false },
    );
    if (!r.ok) {
      console.warn('[slack-api] chat.postEphemeral failed', { error: r.error });
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[slack-api] chat.postEphemeral error', err);
    return false;
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

// Returns whether the update landed, so the finalizer can fall back to a plain
// post when a block render is rejected (e.g. invalid_blocks) instead of silently
// losing the answer.
export async function updateBlocks(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks: unknown[],
): Promise<boolean> {
  try {
    const r = await slackApiCall(token, 'chat.update', { channel, ts, text, blocks });
    if (!r.ok) console.warn('[slack-api] chat.update (blocks) failed', { error: r.error });
    return r.ok;
  } catch (err) {
    console.warn('[slack-api] chat.update (blocks) error', err);
    return false;
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
    // Cosmetic (the ⏳/✅ marker) — don't retry; a dropped reaction is harmless and
    // retrying only stacks latency onto the awaited finalize path.
    const r = await slackApiCall(token, 'reactions.add', { channel, timestamp, name }, { retries: 0 });
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
    // Cosmetic (clears the ⏳) — don't retry; keeps the finalize path from
    // stacking retry latency, and a missed clear is low-harm.
    const r = await slackApiCall(token, 'reactions.remove', { channel, timestamp, name }, { retries: 0 });
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
type StreamTaskStatus = 'pending' | 'in_progress' | 'complete' | 'error';

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

interface StreamTextChunk {
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
interface StreamBlocksChunk {
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
    const r = await slackApiCall(
      token,
      'chat.startStream',
      {
        channel,
        thread_ts: threadTs,
        recipient_user_id: recipientUserId,
        recipient_team_id: recipientTeamId,
        task_display_mode: 'plan',
        chunks,
      },
      { idempotent: false }, // creates a message — a retry would orphan the first
    );
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

// Resolve a bot by the name a human would type, e.g. "Incident reporter".
//
// The slash command is registered with should_escape:false, so Slack sends the
// LITERAL text "@Incident reporter" — never <@U…>. Telling an operator to type
// the thing Slack will not encode is how `link-bot @TheBot` shipped as usage
// that could not work.
//
// Bots only: this feeds link-bot, and returning a human here would hand that
// person's identity to whoever ran the command. An ambiguous match returns null
// rather than guessing — two apps with the same display name is a bad reason to
// bind the wrong one.
//
// One page of 1000 covers any workspace this is plausible in; beyond that the
// operator can paste the member ID, which always works.
export async function findBotUserIdByName(token: string, name: string): Promise<string | null> {
  const want = name.trim().replace(/^@/, '').toLowerCase();
  if (!want) return null;
  try {
    const r = await slackApiCall(token, 'users.list', { limit: 1000 });
    if (!r.ok) {
      console.warn('[slack-api] users.list failed', { error: r.error });
      return null;
    }
    const members = (r.members ?? []) as Array<{
      id?: string; name?: string; deleted?: boolean;
      is_bot?: boolean; is_app_user?: boolean;
      profile?: { display_name?: string; real_name?: string };
    }>;
    const hits = members.filter((m) => {
      if (m.deleted || !m.id) return false;
      if (!m.is_bot && !m.is_app_user) return false;
      return [m.name, m.profile?.display_name, m.profile?.real_name]
        .some((n) => (n ?? '').trim().toLowerCase() === want);
    });
    return hits.length === 1 ? hits[0]!.id! : null;
  } catch (err) {
    console.warn('[slack-api] users.list error', err);
    return null;
  }
}

// Is this Slack principal an app/bot rather than a person?
//
// `link-bot` writes the (workspace, slack_user) -> kortix_user row that
// resolveSlackActor treats as authoritative, so binding a HUMAN's id would make
// that person's later Slack actions run as whoever linked them. Human and bot
// ids are indistinguishable by shape (both U…/W…), so only Slack can answer.
//
// Returns null on ANY uncertainty — missing scope, transport error, unknown user
// — and the caller refuses. Guessing "probably a bot" here is the impersonation.
export async function isBotUser(token: string, userId: string): Promise<boolean | null> {
  try {
    const r = await slackApiCall(token, 'users.info', { user: userId });
    if (!r.ok) {
      console.warn('[slack-api] users.info failed', { error: r.error });
      return null;
    }
    const u = r.user as { is_bot?: boolean; is_app_user?: boolean } | undefined;
    if (!u) return null;
    return Boolean(u.is_bot || u.is_app_user);
  } catch (err) {
    console.warn('[slack-api] users.info error', err);
    return null;
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
