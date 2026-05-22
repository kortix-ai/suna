import { Hono } from 'hono';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  chatChannelBindings,
  chatInstalls,
  chatThreads,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import { createProjectSession, resolveGitTriggerActor } from '../projects';
import {
  loadSlackBotUserIdForProject,
  loadSlackSigningSecretForProject,
  loadSlackTokenForProject,
} from './install-store';
import { slackOauthMode } from './slack-oauth-mode';
import {
  addReaction,
  appendStream,
  getChannelName,
  postBlocks,
  postMessage,
  removeReaction,
  startStream,
  stopStream,
  updateMessage,
  type StreamChunk,
  type StreamTaskChunk,
} from './slack-api';

export const slackWebhookApp = new Hono();

const FIVE_MINUTES = 5 * 60;

// Slack-triggered agent turns run on this model (provider/model form). It is
// passed through to opencode's prompt API for the session's sandbox only.
const SLACK_AGENT_MODEL = 'anthropic/claude-sonnet-4-6';

// ─── Event de-duplication ────────────────────────────────────────────────────
// Slack re-delivers an event if it doesn't get a 200 within 3s. Without this, a
// retry spawns a second sandbox for one message. `event_id` is stable across
// re-deliveries, so a short-TTL seen-set collapses them.
const EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const seenEventIds = new Map<string, number>();

function alreadyHandled(eventId: string | undefined): boolean {
  if (!eventId) return false;
  const now = Date.now();
  for (const [id, expiry] of seenEventIds) {
    if (expiry < now) seenEventIds.delete(id);
  }
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.set(eventId, now + EVENT_DEDUPE_TTL_MS);
  return false;
}

// ─── Turn stream ─────────────────────────────────────────────────────────────
// Each triggering turn opens a Slack stream (chat.startStream) — a live plan
// block. apps/api owns the stream object: it starts it, posts the boot
// checkpoint, finalizes on failure, and exposes relay helpers the agent calls
// (via the agent-cli) to narrate checkpoints and deliver the final answer.
const WORKING_EMOJI = 'hourglass_flowing_sand';
const STREAM_TTL_MS = 15 * 60 * 1000;

interface TurnStream {
  channel: string;
  ts: string;
  token: string;
  triggerTs: string;
  steps: StreamTaskChunk[];
  streaming: boolean; // false = chat.startStream unavailable, plain-message fallback
  expiry: number;
  finalized: boolean;
}

// Keyed by Kortix session id — the agent-cli relays by session id.
const activeStreams = new Map<string, TurnStream>();

// Watchdog — a turn whose stream never finalized (agent crash, opencode
// restart) gets a visible close instead of a forever-"Working…".
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, handle] of activeStreams) {
    if (!handle.finalized && handle.expiry < now) {
      activeStreams.delete(sessionId);
      void finalizeStream(handle, { error: '_The run stopped unexpectedly — try again._' });
    }
  }
}, 60_000).unref();

// Open a stream for a turn. Returns an unbound handle — the caller binds it to
// the session id once known.
async function startTurnStream(
  projectId: string,
  teamId: string,
  event: SlackEvent,
  firstStepTitle: string,
): Promise<TurnStream | null> {
  if (!event.channel || !event.ts || !event.user) return null;
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return null;
  const bootStep: StreamTaskChunk = {
    type: 'task_update',
    id: 'step-0',
    title: firstStepTitle,
    status: 'in_progress',
  };
  const threadTs = event.thread_ts ?? event.ts;
  await addReaction(token, event.channel, event.ts, WORKING_EMOJI);

  const base = {
    channel: event.channel,
    token,
    triggerTs: event.ts,
    expiry: Date.now() + STREAM_TTL_MS,
    finalized: false,
  };
  const streamTs = await startStream(
    token,
    event.channel,
    threadTs,
    event.user,
    teamId,
    [bootStep],
  );
  if (streamTs) {
    return { ...base, ts: streamTs, steps: [bootStep], streaming: true };
  }
  // chat.startStream unavailable — fall back to a plain placeholder message
  // that the final answer edits into place.
  const placeholderTs = await postMessage(
    token,
    event.channel,
    '⏳ _Kortix is working on it…_',
    threadTs,
  );
  if (!placeholderTs) return null;
  return { ...base, ts: placeholderTs, steps: [], streaming: false };
}

// Complete the current checkpoint and append a new one. Returns false when
// there is no live stream for the session (e.g. a non-Slack session).
export async function relayTurnStep(sessionId: string, title: string): Promise<boolean> {
  const handle = activeStreams.get(sessionId);
  if (!handle || handle.finalized) return false;
  // Plain-message fallback has no plan block — accept the step but no-op it so
  // the agent doesn't treat it as a failure.
  if (!handle.streaming) {
    handle.expiry = Date.now() + STREAM_TTL_MS;
    return true;
  }
  const chunks: StreamTaskChunk[] = [];
  const last = handle.steps[handle.steps.length - 1];
  if (last && last.status === 'in_progress') {
    last.status = 'complete';
    chunks.push({ ...last });
  }
  const next: StreamTaskChunk = {
    type: 'task_update',
    id: `step-${handle.steps.length}`,
    title: title.slice(0, 200),
    status: 'in_progress',
  };
  handle.steps.push(next);
  chunks.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  await appendStream(handle.token, handle.channel, handle.ts, chunks);
  return true;
}

// Finalize the stream with the agent's answer.
export async function relayTurnAnswer(sessionId: string, text: string): Promise<boolean> {
  const handle = activeStreams.get(sessionId);
  if (!handle || handle.finalized) return false;
  activeStreams.delete(sessionId);
  await finalizeStream(handle, { answer: text });
  return true;
}

async function finalizeStream(
  handle: TurnStream,
  opts: { answer?: string; error?: string },
): Promise<void> {
  if (handle.finalized) return;
  handle.finalized = true;
  const body = (opts.answer ?? opts.error ?? '_Done._').slice(0, 11000);
  if (handle.streaming) {
    // Closing chunks: the last checkpoint's final state + the answer as a
    // markdown_text chunk (chat.stopStream rejects a top-level markdown_text).
    const chunks: StreamChunk[] = [];
    const last = handle.steps[handle.steps.length - 1];
    if (last && last.status === 'in_progress') {
      last.status = opts.error ? 'error' : 'complete';
      chunks.push({ ...last });
    }
    chunks.push({ type: 'markdown_text', text: body });
    await stopStream(handle.token, handle.channel, handle.ts, chunks);
  } else {
    await updateMessage(handle.token, handle.channel, handle.ts, body);
  }
  await removeReaction(handle.token, handle.channel, handle.triggerTs, WORKING_EMOJI);
}

// ─── Project picker ──────────────────────────────────────────────────────────
const PICKER_TTL_MS = 60 * 60 * 1000;
const pendingPickers = new Map<string, { envelope: SlackEnvelope; expiry: number }>();

// OAuth mode — single endpoint, shared signing secret, route by team_id.
slackWebhookApp.post('/', async (c) => {
  const mode = slackOauthMode();
  if (!mode.available || !mode.signingSecret) {
    return c.json({ error: 'OAuth mode not configured' }, 503);
  }

  const rawBody = await c.req.text();
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, mode.signingSecret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return c.json({ error: 'Invalid JSON' }, 400);
  if (envelope.type === 'url_verification') return c.json({ challenge: envelope.challenge });
  if (envelope.type !== 'event_callback' || !envelope.event) return c.json({ ok: true });
  if (alreadyHandled(envelope.event_id)) return c.json({ ok: true });

  void (async () => {
    const teamId = envelope.team_id ?? envelope.event?.team ?? '';
    if (!teamId) return;
    const resolution = await resolveOauthProject(teamId, envelope.event?.channel);
    if (resolution.kind === 'project') {
      await dispatchSlackEvent(resolution.projectId, envelope);
    } else if (resolution.kind === 'ambiguous') {
      await maybePostPicker(teamId, resolution.projectIds, envelope);
    }
  })().catch((err) => console.error('[slack-webhook] oauth handler failed', err));

  return c.json({ ok: true });
});

// Slack interactivity (Block Kit button clicks). Registered before /:projectId
// so the literal path wins over the BYO param route.
slackWebhookApp.post('/interactivity', async (c) => {
  const mode = slackOauthMode();
  if (!mode.available || !mode.signingSecret) {
    return c.json({ error: 'OAuth mode not configured' }, 503);
  }
  const rawBody = await c.req.text();
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, mode.signingSecret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  const payloadRaw = new URLSearchParams(rawBody).get('payload');
  if (!payloadRaw) return c.json({ ok: true });
  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadRaw) as SlackInteractionPayload;
  } catch {
    return c.json({ ok: true });
  }
  if (payload.type === 'block_actions') {
    void handleBlockAction(payload).catch((err) =>
      console.error('[slack-webhook] block action failed', err),
    );
  }
  return c.json({ ok: true });
});

type ProjectResolution =
  | { kind: 'project'; projectId: string }
  | { kind: 'ambiguous'; projectIds: string[] }
  | { kind: 'pending' }
  | { kind: 'none' };

// Resolve which Kortix project an OAuth-mode Slack event belongs to.
//   1. A per-channel binding wins; a NULL-project binding = picker pending.
//   2. Else, if the workspace has exactly one project, use it and bind lazily.
//   3. Else (2+ projects, unbound channel) it is ambiguous — post a picker.
async function resolveOauthProject(
  teamId: string,
  channelId: string | undefined,
): Promise<ProjectResolution> {
  if (channelId) {
    const [binding] = await db
      .select({ projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'slack'),
          eq(chatChannelBindings.workspaceId, teamId),
          eq(chatChannelBindings.channelId, channelId),
        ),
      )
      .limit(1);
    if (binding) {
      return binding.projectId
        ? { kind: 'project', projectId: binding.projectId }
        : { kind: 'pending' };
    }
  }

  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
  if (installs.length === 0) return { kind: 'none' };
  if (installs.length === 1) {
    const onlyProjectId = installs[0].projectId;
    if (channelId) {
      await db
        .insert(chatChannelBindings)
        .values({ platform: 'slack', workspaceId: teamId, channelId, projectId: onlyProjectId })
        .onConflictDoNothing();
    }
    return { kind: 'project', projectId: onlyProjectId };
  }
  return { kind: 'ambiguous', projectIds: installs.map((i) => i.projectId) };
}

// Post a Block Kit project picker for an ambiguous channel and park the
// triggering event until a button is clicked.
async function maybePostPicker(
  teamId: string,
  projectIds: string[],
  envelope: SlackEnvelope,
): Promise<void> {
  const event = envelope.event;
  if (!event || !event.channel || event.bot_id) return;
  const isMention = event.type === 'app_mention';
  const isDm = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
  if (!isMention && !isDm) return;

  const channelId = event.channel;
  const claimed = await db
    .insert(chatChannelBindings)
    .values({ platform: 'slack', workspaceId: teamId, channelId, projectId: null })
    .onConflictDoNothing()
    .returning({ id: chatChannelBindings.bindingId });
  if (claimed.length === 0) return;

  const token = await loadSlackTokenForProject(projectIds[0]);
  if (!token) return;

  const projectRows = await db
    .select({ projectId: projects.projectId, name: projects.name })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));

  const pickerId = randomUUID();
  const channelName = isDm ? null : await getChannelName(token, channelId);
  const channelLabel = isDm ? 'this DM' : channelName ? `#${channelName}` : `<#${channelId}>`;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Which project should ${channelLabel} use?*\nAsked once — I'll remember it for this channel.`,
      },
    },
    {
      type: 'actions',
      elements: projectRows.map((row, idx) => ({
        type: 'button',
        text: { type: 'plain_text', text: row.name.slice(0, 75) },
        value: JSON.stringify({ k: pickerId, p: row.projectId }),
        action_id: `pick_project_${idx}`,
      })),
    },
  ];

  const now = Date.now();
  for (const [k, v] of pendingPickers) {
    if (v.expiry < now) pendingPickers.delete(k);
  }
  pendingPickers.set(pickerId, { envelope, expiry: now + PICKER_TTL_MS });

  const pickerTs = await postBlocks(
    token,
    channelId,
    `Which project should ${channelLabel} use?`,
    blocks,
    event.thread_ts ?? event.ts,
  );
  if (pickerTs) {
    await db
      .update(chatChannelBindings)
      .set({ pickerTs, channelName: channelName ?? null })
      .where(
        and(
          eq(chatChannelBindings.platform, 'slack'),
          eq(chatChannelBindings.workspaceId, teamId),
          eq(chatChannelBindings.channelId, channelId),
        ),
      );
  }
}

// Handle a project-picker button click.
async function handleBlockAction(payload: SlackInteractionPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.action_id?.startsWith('pick_project')) return;
  let value: { k?: string; p?: string };
  try {
    value = JSON.parse(action.value ?? '{}') as { k?: string; p?: string };
  } catch {
    return;
  }
  const pickerId = value.k;
  const projectId = value.p;
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const pickerTs = payload.message?.ts ?? '';
  if (!pickerId || !projectId || !teamId || !channelId) return;

  const token = await loadSlackTokenForProject(projectId);

  const stillInstalled = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'slack'),
        eq(chatInstalls.workspaceId, teamId),
        eq(chatInstalls.projectId, projectId),
      ),
    )
    .limit(1);
  if (stillInstalled.length === 0) {
    if (token && pickerTs) {
      await updateMessage(
        token,
        channelId,
        pickerTs,
        'That project is no longer connected here — @mention me again to pick another.',
      );
    }
    return;
  }

  await db
    .update(chatChannelBindings)
    .set({ projectId, pickerTs: null })
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, teamId),
        eq(chatChannelBindings.channelId, channelId),
      ),
    );

  const [proj] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (token && pickerTs) {
    await updateMessage(
      token,
      channelId,
      pickerTs,
      `✓ Linked <#${channelId}> to *${proj?.name ?? 'project'}*.`,
    );
  }

  const pending = pendingPickers.get(pickerId);
  if (pending) {
    pendingPickers.delete(pickerId);
    await dispatchSlackEvent(projectId, pending.envelope);
  }
}

// BYO mode — per-project URL, per-project signing secret.
slackWebhookApp.post('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const rawBody = await c.req.text();

  const signingSecret = await loadSlackSigningSecretForProject(projectId);
  if (!signingSecret) return c.json({ error: 'Not configured' }, 404);

  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const envelope = parseEnvelope(rawBody);
  if (!envelope) return c.json({ error: 'Invalid JSON' }, 400);
  if (envelope.type === 'url_verification') return c.json({ challenge: envelope.challenge });
  if (envelope.type !== 'event_callback' || !envelope.event) return c.json({ ok: true });
  if (alreadyHandled(envelope.event_id)) return c.json({ ok: true });

  void dispatchSlackEvent(projectId, envelope).catch((err) =>
    console.error('[slack-webhook] byo handler failed', err),
  );
  return c.json({ ok: true });
});

type EventClass = 'mention' | 'dm' | 'follow_up' | 'ignore';

// Decide whether a Slack event should trigger an agent turn.
async function classifyEvent(
  teamId: string,
  event: SlackEvent,
  botUserId: string | null,
): Promise<EventClass> {
  if (event.type === 'app_mention') return 'mention';
  if (event.type !== 'message') return 'ignore';
  if (event.subtype) return 'ignore';
  // Slack delivers both `app_mention` and `message.*` for a message that
  // mentions the bot. `app_mention` owns those; drop the message twin.
  if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return 'ignore';
  if (event.channel_type === 'im') return 'dm';
  if (event.thread_ts && (await threadIsOwned(teamId, event.thread_ts))) return 'follow_up';
  return 'ignore';
}

async function threadIsOwned(teamId: string, threadTs: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatThreads.threadRowId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'slack'),
        eq(chatThreads.workspaceId, teamId),
        eq(chatThreads.threadId, threadTs),
      ),
    )
    .limit(1);
  return !!row;
}

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

async function dispatchSlackEvent(projectId: string, envelope: SlackEnvelope): Promise<void> {
  const event = envelope.event;
  if (!event) return;

  const teamId = envelope.team_id ?? event.team ?? '';
  const botUserId = await loadSlackBotUserIdForProject(projectId);

  // Echo guard — never process the bot's own messages (including its streamed
  // message and the stream's edits).
  if ((botUserId && event.user === botUserId) || event.bot_id) return;

  const eventClass = await classifyEvent(teamId, event, botUserId);
  if (eventClass === 'ignore') return;

  // Bare "@Kortix" with no task — answer with a nudge, don't burn a sandbox.
  if (eventClass === 'mention' && !stripMentions(event.text ?? '')) {
    const token = await loadSlackTokenForProject(projectId);
    if (token && event.channel) {
      await postMessage(
        token,
        event.channel,
        "Hi! @mention me with a task and I'll get on it.",
        event.thread_ts ?? event.ts,
      );
    }
    return;
  }

  await spawnAgentTurn(projectId, envelope, event);
}

function parseEnvelope(rawBody: string): SlackEnvelope | null {
  try {
    return JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return null;
  }
}

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false;
  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > FIVE_MINUTES) return false;

  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function spawnAgentTurn(
  projectId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
): Promise<void> {
  const teamId = envelope.team_id ?? event.team ?? '';
  const threadId = event.thread_ts ?? event.ts ?? '';

  // Thread continuity: deliver to an existing live session before spawning.
  let revived = false;
  if (teamId && threadId) {
    const [existing] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'slack'),
          eq(chatThreads.workspaceId, teamId),
          eq(chatThreads.threadId, threadId),
        ),
      )
      .limit(1);
    if (existing) {
      const outcome = await deliverFollowUpToSandbox(existing.sessionId, envelope, event);
      if (outcome === 'delivered') {
        const handle = await startTurnStream(projectId, teamId, event, 'On it');
        if (handle) activeStreams.set(existing.sessionId, handle);
        await db
          .update(chatThreads)
          .set({ lastMessageAt: new Date() })
          .where(
            and(
              eq(chatThreads.platform, 'slack'),
              eq(chatThreads.workspaceId, teamId),
              eq(chatThreads.threadId, threadId),
            ),
          );
        return;
      }
      // Transient: alive but the relay failed retryably — don't duplicate.
      if (outcome === 'transient') return;
      // Stale: sandbox gone — spawn fresh and tell the agent context is lost.
      revived = true;
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'slack'),
            eq(chatThreads.workspaceId, teamId),
            eq(chatThreads.threadId, threadId),
          ),
        );
    }
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  const userId = await resolveGitTriggerActor(project.accountId);
  if (!userId) {
    console.warn('[slack-webhook] no actor for project', projectId);
    return;
  }

  // Open the stream now — the user sees a live plan immediately, well before
  // the sandbox is ready.
  const handle = await startTurnStream(projectId, teamId, event, 'Spinning up a sandbox');

  const result = await createProjectSession({
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: renderAgentPrompt(envelope, event, revived),
      opencode_model: SLACK_AGENT_MODEL,
    },
    enforceAccountCap: false,
    metadata: {
      source: 'slack',
      slack: {
        team_id: teamId,
        channel: event.channel,
        user: event.user,
        thread_ts: threadId,
        event_type: event.type,
      },
    },
  });

  if (result.error) {
    console.error('[slack-webhook] createProjectSession failed', result.error.body);
    if (handle) {
      await finalizeStream(handle, { error: "I couldn't start up just now — try again in a moment." });
    }
    return;
  }

  if (result.row && handle) {
    activeStreams.set(result.row.sessionId, handle);
  }

  if (result.row && teamId && threadId) {
    try {
      await db
        .insert(chatThreads)
        .values({
          projectId,
          platform: 'slack',
          workspaceId: teamId,
          threadId,
          sessionId: result.row.sessionId,
        })
        .onConflictDoUpdate({
          target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId],
          set: { sessionId: result.row.sessionId, lastMessageAt: sql`now()` },
        });
    } catch (err) {
      console.warn('[slack-webhook] failed to record chat_threads row', err);
    }
  }
}

type DeliveryOutcome = 'delivered' | 'transient' | 'stale';

// Deliver a follow-up Slack message to the running sandbox's /kortix/prompt.
async function deliverFollowUpToSandbox(
  kortixSessionId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
): Promise<DeliveryOutcome> {
  const [sandbox] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      metadata: sessionSandboxes.metadata,
      status: sessionSandboxes.status,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, kortixSessionId))
    .limit(1);

  if (!sandbox) return 'stale';
  if (sandbox.status === 'stopped' || sandbox.status === 'archived' || sandbox.status === 'error') {
    return 'stale';
  }
  if (sandbox.status !== 'active') return 'transient';

  const daytonaSandboxId = (sandbox.metadata as Record<string, unknown> | null)?.[
    'daytonaSandboxId'
  ];
  if (typeof daytonaSandboxId !== 'string' || !daytonaSandboxId) return 'stale';

  let previewUrl: string;
  let previewToken: string | null;
  try {
    const daytona = getDaytona();
    const sb = await daytona.get(daytonaSandboxId);
    const link = await (sb as { getPreviewLink: (port: number) => Promise<{ url?: string; token?: string }> })
      .getPreviewLink(8000);
    previewUrl = link.url ?? `https://8000-${daytonaSandboxId}.daytonaproxy01.net`;
    previewToken = link.token ?? null;
  } catch (err) {
    console.warn('[slack-webhook] getPreviewLink failed', err);
    return 'transient';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Daytona-Skip-Preview-Warning': 'true',
    'X-Daytona-Disable-CORS': 'true',
  };
  if (previewToken) headers['X-Daytona-Preview-Token'] = previewToken;

  try {
    const res = await fetch(`${previewUrl.replace(/\/$/, '')}/kortix/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: renderFollowUpPrompt(envelope, event) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return 'delivered';
    const bodyText = (await res.text()).slice(0, 300);
    console.warn('[slack-webhook] kortix/prompt returned non-ok', {
      status: res.status,
      body: bodyText,
    });
    if (res.status === 404) return 'stale';
    return 'transient';
  } catch (err) {
    console.warn('[slack-webhook] kortix/prompt fetch failed', err);
    return 'transient';
  }
}

// How the agent narrates its turn and delivers its answer. Shared by the cold
// and follow-up prompts.
const TURN_INSTRUCTIONS = [
  'How to work:',
  '- As you go, post a short progress checkpoint before each major step:',
  '    slack step "Reading the incident logs"',
  '  Keep them human and brief — a few per task, not one per command.',
  '- When you are done, deliver your answer with:',
  '    slack send "<your reply>"',
  '  Write it like a teammate: concise, Slack-formatted, no preamble. This',
  '  finalizes the live update in the thread.',
].join('\n');

function renderFollowUpPrompt(envelope: SlackEnvelope, event: SlackEvent): string {
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';
  return [
    `New message from ${user} in the same Slack thread:`,
    '',
    text,
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(
  envelope: SlackEnvelope,
  event: SlackEvent,
  revived: boolean,
): string {
  const channel = event.channel ?? '?';
  const threadTs = event.thread_ts ?? event.ts ?? '';
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';

  const lines: string[] = [];
  if (revived) {
    lines.push(
      'NOTE: This Slack thread had an earlier conversation, but that session',
      'has ended — you do NOT have its history. Open your reply by briefly',
      'saying you are picking the thread back up without the earlier context.',
      '',
    );
  }
  lines.push(
    "You're answering a message on Slack as a teammate.",
    '',
    `Workspace:  ${envelope.team_id ?? 'unknown'}`,
    `Channel:    ${channel}`,
    `User:       ${user}`,
  );
  if (threadTs) lines.push(`Thread ts:  ${threadTs}`);
  lines.push('', 'Message:', text, '', TURN_INSTRUCTIONS);
  return lines.join('\n');
}

interface SlackEnvelope {
  type: string;
  team_id?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

interface SlackEvent {
  type: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  team?: string;
}

interface SlackInteractionPayload {
  type: string;
  team?: { id: string };
  user?: { id: string };
  channel?: { id: string };
  message?: { ts: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}
