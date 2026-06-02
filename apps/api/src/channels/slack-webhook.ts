import { Hono } from 'hono';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  chatChannelBindings,
  chatInstalls,
  chatThreads,
  projects,
  projectSessions,
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
  joinChannel,
  appendStream,
  deleteMessage,
  getChannelName,
  postBlocks,
  postMessage,
  publishHomeView,
  removeReaction,
  startStream,
  stopStream,
  updateBlocks,
  updateMessage,
  type StreamChunk,
  type StreamTaskChunk,
} from './slack-api';
import { config } from '../config';

export const slackWebhookApp = new Hono();

const FIVE_MINUTES = 5 * 60;

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

const WORKING_EMOJI = 'hourglass_flowing_sand';
const STREAM_TTL_MS = 15 * 60 * 1000;

interface TurnStream {
  channel: string;
  ts: string;
  token: string;
  triggerTs: string;
  steps: StreamTaskChunk[];
  streaming: boolean;
  placeholderActive: boolean;
  expiry: number;
  finalized: boolean;
  projectId: string;
  sessionId: string;
  stopped: boolean;
  teamId: string;
  originatingEvent: SlackEvent;
}

const activeStreams = new Map<string, TurnStream>();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, handle] of activeStreams) {
    if (!handle.finalized && handle.expiry < now) {
      activeStreams.delete(sessionId);
      void finalizeStream(handle, { error: '_The run stopped unexpectedly — try again._' });
    }
  }
}, 60_000).unref();

async function startTurnStream(
  projectId: string,
  teamId: string,
  event: SlackEvent,
  // firstStepTitle was the eager "Spinning up a sandbox" placeholder that
  // appeared in the plan block before the agent did anything. We no longer
  // pre-open the plan stream — the parameter stays for ABI but is ignored.
  _unusedFirstStepTitle?: string,
): Promise<TurnStream | null> {
  if (!event.channel || !event.ts || !event.user) return null;
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return null;
  const threadTs = event.thread_ts ?? event.ts;
  await joinChannel(token, event.channel);
  await addReaction(token, event.channel, event.ts, WORKING_EMOJI);

  const placeholderTs = await postMessage(
    token,
    event.channel,
    '⏳  _On it…_',
    threadTs,
  );
  if (!placeholderTs) return null;

  return {
    channel: event.channel,
    token,
    triggerTs: event.ts,
    expiry: Date.now() + STREAM_TTL_MS,
    finalized: false,
    projectId,
    sessionId: '',
    stopped: false,
    teamId,
    originatingEvent: event,
    ts: placeholderTs,
    steps: [],
    streaming: false,
    placeholderActive: true,
  };
}

// Lazily open a real chat.startStream the moment the agent emits its first
// `slack step`. Deletes the placeholder first so the plan-block message
// appears in its place chronologically.
async function openStreamWithFirstStep(handle: TurnStream, firstStep: StreamTaskChunk): Promise<boolean> {
  if (handle.streaming) return true;
  if (handle.placeholderActive && handle.ts) {
    await deleteMessage(handle.token, handle.channel, handle.ts);
    handle.placeholderActive = false;
    handle.ts = '';
  }
  const ev = handle.originatingEvent;
  const threadTs = ev.thread_ts ?? ev.ts;
  if (!ev.channel || !ev.user || !threadTs) return false;
  const streamTs = await startStream(
    handle.token,
    ev.channel,
    threadTs,
    ev.user,
    handle.teamId,
    [firstStep],
  );
  if (!streamTs) return false;
  handle.ts = streamTs;
  handle.steps = [firstStep];
  handle.streaming = true;
  return true;
}

function buildSlackTurnEnv(teamId: string, event: SlackEvent): Record<string, string> {
  const env: Record<string, string> = {};
  if (teamId) env.SLACK_TEAM_ID = teamId;
  if (event.channel) env.SLACK_CHANNEL_ID = event.channel;
  if (event.thread_ts ?? event.ts) env.SLACK_THREAD_TS = (event.thread_ts ?? event.ts)!;
  if (event.ts) env.SLACK_TRIGGER_TS = event.ts;
  if (event.user) env.SLACK_USER_ID = event.user;
  return env;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

interface PendingAsk {
  askId: string;
  questions: QuestionInfo[];
  resolve: (answers: string[][]) => void;
  expiry: number;
  channel: string;
  messageTs: string | null;
  token: string;
  sessionId: string;
  projectId: string;
  teamId: string;
  originatingEvent: SlackEvent;
}

const ASK_TTL_MS = 15 * 60 * 1000;
const pendingAsks = new Map<string, PendingAsk>();

setInterval(() => {
  const now = Date.now();
  for (const [askId, ask] of pendingAsks) {
    if (ask.expiry < now) {
      pendingAsks.delete(askId);
      ask.resolve(ask.questions.map(() => []));
    }
  }
}, 60_000).unref();

export async function postQuestionAndWait(
  sessionId: string,
  questions: QuestionInfo[],
): Promise<{ ok: boolean; ask_id?: string; answers?: string[][]; error?: string }> {
  const handle = activeStreams.get(sessionId);
  if (!handle) {
    return { ok: false, error: 'No active Slack turn for this session.' };
  }

  const teamId = handle.teamId;
  const originatingEvent = handle.originatingEvent;

  await finalizeStream(handle, { answer: '_Waiting on your answer below…_' });
  activeStreams.delete(sessionId);

  const askId = randomUUID();
  const blocks = buildQuestionBlocks(askId, questions);
  const messageTs = await postBlocks(
    handle.token,
    handle.channel,
    questions[0]?.question?.slice(0, 200) ?? 'A question for you',
    blocks,
    handle.triggerTs,
  );
  if (!messageTs) {
    return { ok: false, error: 'Failed to post the form to Slack.' };
  }
  const answers = await new Promise<string[][]>((resolve) => {
    pendingAsks.set(askId, {
      askId,
      questions,
      resolve,
      expiry: Date.now() + ASK_TTL_MS,
      channel: handle.channel,
      messageTs,
      token: handle.token,
      sessionId,
      projectId: handle.projectId,
      teamId,
      originatingEvent,
    });
  });
  return { ok: true, ask_id: askId, answers };
}

function buildQuestionBlocks(askId: string, questions: QuestionInfo[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  questions.forEach((q, i) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeMrkdwn(q.question)}*` },
    });
    if (q.options.length > 0) {
      const options = q.options.map((o) => {
        const opt: Record<string, unknown> = {
          text: { type: 'plain_text', text: o.label.slice(0, 75), emoji: true },
          value: o.label.slice(0, 75),
        };
        if (o.description) {
          opt.description = {
            type: 'plain_text',
            text: o.description.slice(0, 75),
            emoji: true,
          };
        }
        return opt;
      });
      blocks.push({
        type: 'input',
        block_id: `q_${i}_choice`,
        label: { type: 'plain_text', text: 'Choose', emoji: true },
        element: q.multiple
          ? { type: 'checkboxes', action_id: 'value', options }
          : { type: 'radio_buttons', action_id: 'value', options },
        optional: q.custom !== false,
      });
    }
    if (q.custom !== false) {
      blocks.push({
        type: 'input',
        block_id: `q_${i}_custom`,
        label: { type: 'plain_text', text: q.options.length > 0 ? 'Or type your own answer' : 'Your answer', emoji: true },
        element: { type: 'plain_text_input', action_id: 'value', multiline: false },
        optional: q.options.length > 0,
      });
    }
  });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Submit', emoji: true },
        style: 'primary',
        action_id: 'ask_submit',
        value: askId,
      },
    ],
  });
  return blocks;
}

export async function relayTurnStep(
  sessionId: string,
  title: string,
  opts: {
    detail?: string;
    outputForPrev?: string;
    sourcesForPrev?: Array<{ url: string; text: string }>;
  } = {},
): Promise<boolean> {
  const handle = activeStreams.get(sessionId);
  if (!handle || handle.finalized) {
    console.warn('[slack-webhook] turn-stream step relay dropped — no active stream', {
      sessionId,
      title: title.slice(0, 80),
      finalized: handle?.finalized ?? null,
    });
    return false;
  }

  if (!handle.streaming) {
    const firstStep: StreamTaskChunk = {
      type: 'task_update',
      id: 'step-0',
      title: title.slice(0, 200),
      status: 'in_progress',
    };
    if (opts.detail) firstStep.details = opts.detail.slice(0, 500);
    const opened = await openStreamWithFirstStep(handle, firstStep);
    if (!opened) return false;
    handle.expiry = Date.now() + STREAM_TTL_MS;
    return true;
  }
  const chunks: StreamTaskChunk[] = [];
  const last = handle.steps[handle.steps.length - 1];
  if (last && last.status === 'in_progress') {
    last.status = 'complete';
    if (opts.outputForPrev) last.output = opts.outputForPrev.slice(0, 500);
    if (opts.sourcesForPrev && opts.sourcesForPrev.length > 0) {
      last.sources = opts.sourcesForPrev.slice(0, 8).map((s) => ({
        type: 'url',
        url: s.url,
        text: s.text.slice(0, 80),
      }));
    }
    chunks.push({
      type: 'task_update',
      id: last.id,
      title: last.title,
      status: 'complete',
      ...(last.output ? { output: last.output } : {}),
      ...(last.sources ? { sources: last.sources } : {}),
    });
  }
  const next: StreamTaskChunk = {
    type: 'task_update',
    id: `step-${handle.steps.length}`,
    title: title.slice(0, 200),
    status: 'in_progress',
  };
  if (opts.detail) next.details = opts.detail.slice(0, 500);
  handle.steps.push(next);
  chunks.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  await appendStream(handle.token, handle.channel, handle.ts, chunks);
  return true;
}

export async function relayTurnAnswer(
  sessionId: string,
  text: string,
  blocks?: unknown[],
): Promise<boolean> {
  const handle = activeStreams.get(sessionId);
  if (!handle || handle.finalized) return false;
  activeStreams.delete(sessionId);
  await finalizeStream(handle, { answer: text, blocks });
  return true;
}

async function finalizeStream(
  handle: TurnStream,
  opts: { answer?: string; error?: string; blocks?: unknown[] },
): Promise<void> {
  if (handle.finalized) return;
  handle.finalized = true;
  const body = (opts.answer ?? opts.error ?? '_Done._').slice(0, 11000);
  const ev = handle.originatingEvent;
  const threadRoot = ev.thread_ts ?? ev.ts ?? handle.triggerTs;
  if (handle.streaming) {
    const chunks: StreamChunk[] = [];
    const last = handle.steps[handle.steps.length - 1];
    if (last && last.status === 'in_progress') {
      last.status = opts.error ? 'error' : 'complete';
      chunks.push({
        type: 'task_update',
        id: last.id,
        title: last.title,
        status: last.status,
      });
    }
    if (opts.blocks && opts.blocks.length > 0) {
      chunks.push({ type: 'blocks', blocks: opts.blocks });
    } else {
      chunks.push({ type: 'markdown_text', text: body });
    }
    await stopStream(handle.token, handle.channel, handle.ts, chunks);
    await updateBlocks(
      handle.token,
      handle.channel,
      handle.ts,
      planTitleFor(opts),
      buildFinalPlanBlocks(handle, body, opts),
    );
  } else if (handle.placeholderActive && handle.ts) {
    await deleteMessage(handle.token, handle.channel, handle.ts);
    handle.placeholderActive = false;
    if (opts.blocks && opts.blocks.length > 0) {
      await postBlocks(handle.token, handle.channel, body, opts.blocks, threadRoot);
    } else {
      await postMessage(handle.token, handle.channel, body, threadRoot);
    }
  }
  await removeReaction(handle.token, handle.channel, handle.triggerTs, WORKING_EMOJI);
  if (opts.answer && !opts.error && !handle.stopped) {
    await addReaction(handle.token, handle.channel, handle.triggerTs, 'white_check_mark');
  }
}

function planTitleFor(opts: { answer?: string; error?: string }): string {
  if (opts.error) return 'Run failed';
  return 'Task complete';
}

function buildFinalPlanBlocks(
  handle: TurnStream,
  body: string,
  opts: { answer?: string; error?: string; blocks?: unknown[] },
): unknown[] {
  const tasks = handle.steps.map((s) => {
    const task: Record<string, unknown> = {
      task_id: s.id,
      title: s.title,
      status: s.status,
    };
    if (s.details) {
      task.details = {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: s.details }] }],
      };
    }
    if (s.output) {
      task.output = {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: s.output }] }],
      };
    }
    if (s.sources && s.sources.length > 0) task.sources = s.sources;
    return task;
  });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'plan',
      title: planTitleFor(opts),
      tasks,
    },
  ];
  if (opts.blocks && opts.blocks.length > 0) {
    for (const b of opts.blocks) blocks.push(b as Record<string, unknown>);
  } else if (body && body !== '_Done._') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body } });
  }
  return blocks;
}

const PICKER_TTL_MS = 60 * 60 * 1000;
const pendingPickers = new Map<string, { envelope: SlackEnvelope; expiry: number }>();

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
    if (envelope.event?.type === 'member_joined_channel') {
      await maybePostChannelIntro(teamId, envelope.event);
      return;
    }
    if (
      envelope.event?.type === 'app_home_opened' &&
      envelope.event.tab === 'home' &&
      envelope.event.user
    ) {
      await publishHomeForUser(teamId, envelope.event.user);
      return;
    }
    const resolution = await resolveOauthProject(teamId, envelope.event?.channel);
    if (resolution.kind === 'project') {
      await dispatchSlackEvent(resolution.projectId, envelope);
    } else if (resolution.kind === 'ambiguous') {
      await maybePostPicker(teamId, resolution.projectIds, envelope);
    } else if (resolution.kind === 'pending') {
      const installs = await db
        .select({ projectId: chatInstalls.projectId })
        .from(chatInstalls)
        .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
      if (installs.length > 0) {
        await maybePostPicker(teamId, installs.map((i) => i.projectId), envelope);
      }
    }
  })().catch((err) => console.error('[slack-webhook] oauth handler failed', err));

  return c.json({ ok: true });
});

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

// Slash commands — Slack POSTs application/x-www-form-urlencoded here when
// a user runs `/kortix …` in any channel/DM. Must respond within 3s.
slackWebhookApp.post('/commands', async (c) => {
  const mode = slackOauthMode();
  if (!mode.available || !mode.signingSecret) {
    return c.json({ response_type: 'ephemeral', text: 'OAuth mode not configured on this server.' }, 503);
  }
  const rawBody = await c.req.text();
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, mode.signingSecret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const params = new URLSearchParams(rawBody);
  const text = (params.get('text') ?? '').trim();
  const teamId = params.get('team_id') ?? '';
  const channelId = params.get('channel_id') ?? '';

  const [sub, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  const subLower = (sub || 'help').toLowerCase();

  try {
    const response = await handleSlashCommand(subLower, arg, { teamId, channelId });
    return c.json(response);
  } catch (err) {
    console.error('[slack-webhook] slash command failed', err);
    return c.json({
      response_type: 'ephemeral',
      text: 'Something went wrong handling that command. Try again in a moment.',
    });
  }
});

type ProjectResolution =
  | { kind: 'project'; projectId: string }
  | { kind: 'ambiguous'; projectIds: string[] }
  | { kind: 'pending' }
  | { kind: 'none' };

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
        .onConflictDoNothing({
          target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
        });
    }
    return { kind: 'project', projectId: onlyProjectId };
  }
  return { kind: 'ambiguous', projectIds: installs.map((i) => i.projectId) };
}

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
    .onConflictDoNothing({
      target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
    })
    .returning({ id: chatChannelBindings.bindingId });
  const isFreshClaim = claimed.length > 0;

  const token = await loadSlackTokenForProject(projectIds[0]);
  if (!token) return;

  if (!isFreshClaim) {
    const [existing] = await db
      .select({ pickerTs: chatChannelBindings.pickerTs, projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, teamId),
        eq(chatChannelBindings.channelId, channelId),
      ))
      .limit(1);
    if (existing?.projectId) return;
    if (existing?.pickerTs) {
      await deleteMessage(token, channelId, existing.pickerTs);
    }
  }

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

type SlashResponse = { response_type: 'ephemeral' | 'in_channel'; text?: string; blocks?: unknown[] };

async function handleSlashCommand(
  sub: string,
  arg: string,
  ctx: { teamId: string; channelId: string },
): Promise<SlashResponse> {
  switch (sub) {
    case 'projects':
    case 'list':
      return slashProjects(ctx);
    case 'switch':
    case 'use':
    case 'rebind':
      return slashSwitch(ctx);
    case 'unbind':
      return slashUnbind(ctx);
    case 'sessions':
      return slashSessions(ctx);
    case 'whoami':
    case 'who':
      return slashWhoami(ctx);
    case 'help':
    case '':
      return slashHelp();
    default:
      return {
        response_type: 'ephemeral',
        text: `Unknown subcommand \`${sub}\`. Try \`/kortix help\`.`,
      };
  }
  void arg;
}

function slashHelp(): SlashResponse {
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚡  Kortix slash commands', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Drive Kortix from any Slack channel. All responses are private to you.',
        },
      },
      { type: 'divider' },
      ...[
        { cmd: '/kortix projects', desc: 'List every Kortix project connected to this workspace.' },
        { cmd: '/kortix switch',   desc: 'Bind this channel to a different project (opens a picker).' },
        { cmd: '/kortix unbind',   desc: 'Clear this channel\'s project binding.' },
        { cmd: '/kortix sessions', desc: 'Show the last 5 sessions started in this workspace.' },
        { cmd: '/kortix whoami',   desc: 'What project is currently bound to this channel.' },
        { cmd: '/kortix help',     desc: 'This message.' },
      ].map((r) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `\`${r.cmd}\`\n${r.desc}` },
      })),
    ],
  };
}

async function slashProjects(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const rows = await listWorkspaceProjects(ctx.teamId);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*No Kortix projects connected yet.*\nHead to your Kortix dashboard to link one to this workspace.',
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
            style: 'primary',
            url: (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, ''),
            action_id: 'projects_empty_dashboard',
          },
        },
      ],
    };
  }
  const current = await currentChannelProjectId(ctx);
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Connected projects · ${rows.length}`, emoji: true },
    },
  ];
  if (rows.length >= 2) {
    blocks.push({
      type: 'carousel',
      elements: rows.map((p) => {
        const isBound = p.projectId === current;
        const og = repoOgImage(p.repoUrl);
        const card: Record<string, unknown> = {
          type: 'card',
          block_id: `proj_${p.projectId}`,
          title: { type: 'mrkdwn', text: `${isBound ? '✓ ' : ''}*${escapeMrkdwn(p.name)}*` },
          subtitle: { type: 'mrkdwn', text: `_${escapeMrkdwn(repoLabel(p.repoUrl))}_` },
          body: {
            type: 'mrkdwn',
            text: isBound ? '🟢  Bound to this channel — `@`-mentions here go to this project.' : '🟢  Connected to this workspace.',
          },
          actions: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Open', emoji: true },
              style: 'primary',
              url: `${dashboardBase}/projects/${p.projectId}`,
              action_id: `projects_open_${p.projectId}`,
            },
            ...(!isBound ? [{
              type: 'button',
              text: { type: 'plain_text', text: 'Switch to this', emoji: true },
              action_id: `switch_project_${p.projectId}`,
              value: JSON.stringify({ p: p.projectId, c: ctx.channelId }),
            }] : []),
          ],
        };
        void og;
        return card;
      }),
    });
  } else {
    const p = rows[0];
    const isBound = p.projectId === current;
    const og = repoOgImage(p.repoUrl);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${isBound ? '✓ ' : '🟢 '}*${escapeMrkdwn(p.name)}*\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_\n${isBound ? '🟢  Bound to this channel.' : ''}`,
      },
      ...(og ? { accessory: { type: 'image', image_url: og, alt_text: `${p.name} repo` } } : {}),
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open project', emoji: true },
          style: 'primary',
          url: `${dashboardBase}/projects/${p.projectId}`,
          action_id: `projects_open_${p.projectId}`,
        },
      ],
    });
  }
  return { response_type: 'ephemeral', blocks };
}

async function slashSwitch(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const rows = await listWorkspaceProjects(ctx.teamId);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*No projects to switch to.*\nLink a project to this workspace from your Kortix dashboard first.' },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
            style: 'primary',
            url: (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, ''),
            action_id: 'switch_empty_dashboard',
          },
        },
      ],
    };
  }
  const current = await currentChannelProjectId(ctx);
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Switch this channel to…', emoji: true },
    },
  ];
  if (rows.length >= 2) {
    blocks.push({
      type: 'carousel',
      elements: rows.map((p) => {
        const isBound = p.projectId === current;
        const og = repoOgImage(p.repoUrl);
        const card: Record<string, unknown> = {
          type: 'card',
          block_id: `switch_${p.projectId}`,
          title: { type: 'mrkdwn', text: `${isBound ? '✓ ' : ''}*${escapeMrkdwn(p.name)}*` },
          subtitle: { type: 'mrkdwn', text: `_${escapeMrkdwn(repoLabel(p.repoUrl))}_` },
          body: {
            type: 'mrkdwn',
            text: isBound ? 'Currently bound to this channel.' : 'Pick this to route `@`-mentions here to this project.',
          },
          actions: [
            {
              type: 'button',
              text: { type: 'plain_text', text: isBound ? '✓ Current' : 'Pick this', emoji: true },
              style: isBound ? undefined : 'primary',
              action_id: `switch_project_${p.projectId}`,
              value: JSON.stringify({ p: p.projectId, c: ctx.channelId }),
            },
          ],
        };
        void og;
        return card;
      }),
    });
  } else {
    const p = rows[0];
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Only one project connected: *${escapeMrkdwn(p.name)}*\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_`,
      },
    });
  }
  return { response_type: 'ephemeral', blocks };
}

async function slashUnbind(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  if (!ctx.channelId) {
    return { response_type: 'ephemeral', text: 'No channel context — run this from inside a channel.' };
  }
  await db
    .delete(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.workspaceId, ctx.teamId),
      eq(chatChannelBindings.channelId, ctx.channelId),
    ));
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Unbound.*\nThe next `@`-mention will show the project picker again.',
        },
      },
    ],
  };
}

async function slashSessions(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const rows = await db
    .select({
      projectId: chatThreads.projectId,
      sessionId: chatThreads.sessionId,
      lastMessageAt: chatThreads.lastMessageAt,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.platform, 'slack'), eq(chatThreads.workspaceId, ctx.teamId)))
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(5);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*No recent Kortix sessions in this workspace.*\n`@`-mention me in any channel to start one.' } },
      ],
    };
  }
  const projectIds = Array.from(new Set(rows.map((r) => r.projectId)));
  const projectRows = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));
  const projectById = new Map(projectRows.map((p) => [p.projectId, p]));
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Recent sessions', emoji: true },
      },
      ...rows.flatMap((r) => {
        const p = projectById.get(r.projectId);
        const projectName = p?.name ?? 'project';
        const og = p ? repoOgImage(p.repoUrl) : null;
        const section: Record<string, unknown> = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${escapeMrkdwn(projectName)}*  ·  ${formatRelativeTime(r.lastMessageAt)}\n_<${dashboardBase}/projects/${r.projectId}/sessions/${r.sessionId}|Open session>_`,
          },
          ...(og ? { accessory: { type: 'image', image_url: og, alt_text: `${projectName} repo` } } : {}),
        };
        return [section];
      }),
    ],
  };
}

async function slashWhoami(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const currentId = await currentChannelProjectId(ctx);
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
  if (!currentId) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*No project bound to this channel.*\nRun `/kortix switch` to pick one.',
          },
        },
      ],
    };
  }
  const [p] = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.projectId, currentId))
    .limit(1);
  if (!p) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*This channel\'s bound project no longer exists.*\nRun `/kortix switch` to rebind.' },
        },
      ],
    };
  }
  const og = repoOgImage(p.repoUrl);
  const section: Record<string, unknown> = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🟢  *${escapeMrkdwn(p.name)}*  ·  ✓ bound to this channel\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_`,
    },
  };
  if (og) section.accessory = { type: 'image', image_url: og, alt_text: `${p.name} repo` };
  return {
    response_type: 'ephemeral',
    blocks: [
      section,
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open project', emoji: true },
            style: 'primary',
            url: `${dashboardBase}/projects/${p.projectId}`,
            action_id: `whoami_open_${p.projectId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View on GitHub', emoji: true },
            url: p.repoUrl,
            action_id: `whoami_repo_${p.projectId}`,
          },
        ],
      },
    ],
  };
}

async function listWorkspaceProjects(teamId: string): Promise<Array<{ projectId: string; name: string; repoUrl: string }>> {
  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
  if (installs.length === 0) return [];
  const ids = installs.map((i) => i.projectId);
  return db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.projectId, ids));
}

async function currentChannelProjectId(ctx: { teamId: string; channelId: string }): Promise<string | null> {
  if (!ctx.channelId) return null;
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.workspaceId, ctx.teamId),
      eq(chatChannelBindings.channelId, ctx.channelId),
    ))
    .limit(1);
  return binding?.projectId ?? null;
}

async function handleAskSubmit(payload: SlackInteractionPayload, askId: string): Promise<void> {
  const pending = pendingAsks.get(askId);
  if (!pending) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'This form has already been submitted or expired.',
    });
    return;
  }
  pendingAsks.delete(askId);

  const values = payload.state?.values ?? {};
  const answers: string[][] = pending.questions.map((q, i) => {
    const out: string[] = [];
    const choice = values[`q_${i}_choice`]?.value;
    if (choice) {
      if (q.multiple) {
        for (const opt of choice.selected_options ?? []) {
          if (opt?.value) out.push(opt.value);
        }
      } else if (choice.selected_option?.value) {
        out.push(choice.selected_option.value);
      }
    }
    const custom = values[`q_${i}_custom`]?.value?.value?.trim();
    if (custom) out.push(custom);
    return out;
  });

  // Spin up a fresh stream BELOW the form so the agent's continuation
  // (more `slack step`s + the final `slack send`) lands in chronological
  // order under the user's submitted answers. Without this, the old
  // (parked) stream message above the form gets edited in-place.
  try {
    const newHandle = await startTurnStream(
      pending.projectId,
      pending.teamId,
      pending.originatingEvent,
      'Continuing…',
    );
    if (newHandle) {
      newHandle.sessionId = pending.sessionId;
      activeStreams.set(pending.sessionId, newHandle);
    }
  } catch (err) {
    console.warn('[slack-webhook] post-question stream re-open failed', err);
  }

  pending.resolve(answers);

  if (pending.messageTs) {
    const recap: Array<Record<string, unknown>> = [];
    pending.questions.forEach((q, i) => {
      recap.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${escapeMrkdwn(q.question)}*` },
      });
      const picked = answers[i] ?? [];
      if (picked.length > 0) {
        recap.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `→ ${picked.map(escapeMrkdwn).join(', ')}` }],
        });
      }
    });
    recap.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '✅  Submitted' }],
    });
    await updateBlocks(pending.token, pending.channel, pending.messageTs, 'Submitted.', recap);
  }
}

// Agent-emitted button click (carousel cards, actions blocks). Routes the
// click back into the thread as a synthesized follow-up so the agent's next
// turn picks up from the user's choice.
async function handleAgentClick(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !userId || !threadTs) return;

  const label = (action.text?.text ?? action.action_id ?? '').trim();
  const value = (action.value ?? '').trim();

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text: `On it — picked *${label || action.action_id}*.`,
  });

  const [thread] = await db
    .select({ projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.platform, 'slack'),
      eq(chatThreads.workspaceId, teamId),
      eq(chatThreads.threadId, threadTs),
    ))
    .limit(1);
  if (!thread) return;

  const lines = [`[Button click] The user clicked *${label || action.action_id}*.`];
  if (action.action_id) lines.push(`action_id: \`${action.action_id}\``);
  if (value) lines.push(`value: \`${value}\``);
  lines.push('', 'Continue the turn based on this choice.');

  const event: SlackEvent = {
    type: 'message',
    user: userId,
    channel: channelId,
    text: lines.join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = {
    type: 'event_callback',
    team_id: teamId,
    event,
  };
  await spawnAgentTurn(thread.projectId, envelope, event);
}

async function handleSwitchProject(payload: SlackInteractionPayload, rawValue: string): Promise<void> {
  let value: { p?: string; c?: string };
  try {
    value = JSON.parse(rawValue || '{}') as { p?: string; c?: string };
  } catch {
    return;
  }
  const projectId = value.p;
  const channelId = value.c ?? payload.channel?.id;
  const teamId = payload.team?.id ?? '';
  if (!projectId || !channelId || !teamId) return;

  const [install] = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(and(
      eq(chatInstalls.platform, 'slack'),
      eq(chatInstalls.workspaceId, teamId),
      eq(chatInstalls.projectId, projectId),
    ))
    .limit(1);
  if (!install) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: 'That project is no longer connected to this workspace.',
    });
    return;
  }

  await db
    .insert(chatChannelBindings)
    .values({ platform: 'slack', workspaceId: teamId, channelId, projectId, pickerTs: null })
    .onConflictDoUpdate({
      target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
      set: { projectId, pickerTs: null },
    });

  const [p] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: `Switched this channel to *${p?.name ?? 'project'}*.`,
  });
}

async function respondViaUrl(url: string | undefined, body: unknown): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[slack-webhook] response_url POST failed', err);
  }
}

async function handleBlockAction(payload: SlackInteractionPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.action_id) return;

  if (action.action_id.startsWith('switch_project_')) {
    await handleSwitchProject(payload, action.value ?? '');
    return;
  }

  if (action.action_id === 'ask_submit') {
    await handleAskSubmit(payload, action.value ?? '');
    return;
  }

  if (action.action_id === 'value') {
    // No-op: live input/select element clicks before Submit. Slack still POSTs
    // here so we can preview/validate; we just don't act until ask_submit fires.
    return;
  }

  // Anything else is an agent-emitted button (typically inside a carousel card
  // or actions block from `slack send --blocks-file ...`). Route the click back
  // into the thread as a synthesized follow-up so the agent can continue.
  if (!action.action_id.startsWith('pick_project') && !action.action_id.startsWith('switch_project_')) {
    await handleAgentClick(payload, action);
    return;
  }

  if (!action.action_id.startsWith('pick_project')) return;
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

async function classifyEvent(
  teamId: string,
  event: SlackEvent,
  botUserId: string | null,
): Promise<EventClass> {
  if (event.type === 'app_mention') return 'mention';
  if (event.type !== 'message') return 'ignore';
  if (event.subtype) return 'ignore';
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

const CHANNEL_INTRO_FALLBACK = "Kortix is now connected to this channel. Mention @Kortix with a task to get started.";

async function postChannelIntro(projectId: string, channelId: string): Promise<void> {
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return;
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Kortix is connected to this channel', emoji: false },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Mention `@Kortix` with a task. The agent will read your repository, work in an isolated sandbox, and reply in-thread. Follow-up messages in the same thread continue the conversation.',
          '',
          'Run `/kortix help` to see available commands.',
        ].join('\n'),
      },
    },
  ];
  await postBlocks(token, channelId, CHANNEL_INTRO_FALLBACK, blocks);
}

async function publishHomeForUser(teamId: string, userId: string): Promise<void> {
  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
  if (installs.length === 0) return;

  const token = await loadSlackTokenForProject(installs[0].projectId);
  if (!token) return;

  const projectIds = installs.map((i) => i.projectId);
  const projectRows = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));

  const recent = await db
    .select({
      projectId: chatThreads.projectId,
      lastMessageAt: chatThreads.lastMessageAt,
      threadId: chatThreads.threadId,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.platform, 'slack'), eq(chatThreads.workspaceId, teamId)))
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(5);

  const view = buildHomeView({ projects: projectRows, recent });
  await publishHomeView(token, userId, view);
}

const HOME_EXAMPLES: Array<{ emoji: string; prompt: string }> = [
  { emoji: '🔍', prompt: '@Kortix scan this codebase and write me a one-pager' },
  { emoji: '🔧', prompt: '@Kortix open a PR that switches our logger to pino' },
  { emoji: '📊', prompt: '@Kortix what changed on main this week?' },
  { emoji: '📦', prompt: '@Kortix pull yesterday\'s sign-ups, group them by source, drop the CSV here' },
];

const PROJECT_COVERS = [
  '1517694712202-14dd9538aa97',
  '1555066931-4365d14bab8c',
  '1542831371-29b0f74f9713',
  '1532619675605-1ede6c2ed2b0',
  '1551033406-611cf9a28f67',
  '1573164713988-8665fc963095',
  '1551288049-bebda4e38f71',
];

function projectCoverUrl(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % PROJECT_COVERS.length;
  return `https://images.unsplash.com/photo-${PROJECT_COVERS[idx]}?w=1600&h=400&fit=crop&q=80&auto=format`;
}

const DEFAULT_HOME_HERO_URL =
  'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1600&h=480&fit=crop&q=80&auto=format';

interface HomeProjectRow { projectId: string; name: string; repoUrl: string }
interface HomeRecentRow { projectId: string; lastMessageAt: Date; threadId: string }

function repoOgImage(repoUrl: string): string | null {
  const m = repoUrl.match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/i);
  if (!m) return null;
  return `https://opengraph.githubassets.com/1/${m[1]}/${m[2]}`;
}

function repoLabel(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');
}

function buildHomeView(input: { projects: HomeProjectRow[]; recent: HomeRecentRow[] }): Record<string, unknown> {
  const dashboardBase = (config.KORTIX_URL || 'https://kortix.com').replace(/\/$/, '');
  const heroUrl = config.SLACK_HOME_HERO_URL || DEFAULT_HOME_HERO_URL;
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: 'image',
    image_url: heroUrl,
    alt_text: 'Kortix — AI command center for your company',
  });
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '👋  Welcome to Kortix', emoji: true },
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Your AI command center, right here in Slack.*',
        '',
        "`@`-mention me in any channel with a task and I'll read the repo, run the work in an isolated sandbox, and reply in the thread. Follow-ups stay in context.",
      ].join('\n'),
    },
  });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: '⚡  *Live plan streaming*' },
      { type: 'mrkdwn', text: '🧵  *Thread memory*' },
      { type: 'mrkdwn', text: '📁  *File I/O*' },
      { type: 'mrkdwn', text: '🔒  *Isolated sandbox*' },
    ],
  });

  blocks.push({ type: 'divider' });

  if (input.projects.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*No projects connected yet.*\nHead to your Kortix dashboard to link a project to this workspace.' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Open dashboard' },
        style: 'primary',
        url: dashboardBase,
        action_id: 'home_open_dashboard',
      },
    });
  } else {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `Connected projects · ${input.projects.length}`, emoji: true },
    });
    for (const p of input.projects) {
      const label = repoLabel(p.repoUrl);
      // Cover image — full-width card hero.
      blocks.push({
        type: 'image',
        image_url: projectCoverUrl(p.projectId),
        alt_text: `${p.name} cover`,
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${escapeMrkdwn(p.name)}*`,
            `<${p.repoUrl}|${escapeMrkdwn(label)}>`,
          ].join('\n'),
        },
      });
      blocks.push({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '🟢  *Connected*' },
          { type: 'mrkdwn', text: `🪐  <${dashboardBase}/projects/${p.projectId}|Dashboard>` },
        ],
      });
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open project' },
            style: 'primary',
            url: `${dashboardBase}/projects/${p.projectId}`,
            action_id: `home_open_${p.projectId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View on GitHub' },
            url: p.repoUrl,
            action_id: `home_repo_${p.projectId}`,
          },
        ],
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: 'Try a task', emoji: true },
  });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '_Paste any of these into a channel I\'m in:_' },
  });
  for (const ex of HOME_EXAMPLES) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${ex.emoji}  \`${ex.prompt}\`` },
    });
  }

  if (input.recent.length > 0) {
    const projectById = new Map(input.projects.map((p) => [p.projectId, p]));
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Recent activity', emoji: true },
    });
    for (const r of input.recent) {
      const proj = projectById.get(r.projectId);
      const projectName = proj?.name ?? 'project';
      const when = formatRelativeTime(r.lastMessageAt);
      const elements: Array<Record<string, unknown>> = [];
      const og = proj ? repoOgImage(proj.repoUrl) : null;
      if (og) elements.push({ type: 'image', image_url: og, alt_text: `${projectName} repo` });
      elements.push({ type: 'mrkdwn', text: `*${escapeMrkdwn(projectName)}*  ·  ${when}` });
      blocks.push({ type: 'context', elements });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `🪐  Managed by Kortix  ·  <${dashboardBase}|kortix.com>  ·  <${dashboardBase}/docs|Docs>  ·  <${dashboardBase}/settings|Settings>` },
    ],
  });

  return { type: 'home', blocks };
}

function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function maybePostChannelIntro(teamId: string, event: SlackEvent): Promise<void> {
  if (!event.channel) return;
  const [install] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)))
    .limit(1);
  if (!install) return;
  const botUserId = await loadSlackBotUserIdForProject(install.projectId);
  if (!botUserId || event.user !== botUserId) return;
  await postChannelIntro(install.projectId, event.channel);
}

async function dispatchSlackEvent(projectId: string, envelope: SlackEnvelope): Promise<void> {
  const event = envelope.event;
  if (!event) return;

  const teamId = envelope.team_id ?? event.team ?? '';
  const botUserId = await loadSlackBotUserIdForProject(projectId);

  if (
    event.type === 'member_joined_channel' &&
    botUserId &&
    event.user === botUserId &&
    event.channel
  ) {
    await postChannelIntro(projectId, event.channel);
    return;
  }

  if ((botUserId && event.user === botUserId) || event.bot_id) return;

  const eventClass = await classifyEvent(teamId, event, botUserId);
  if (eventClass === 'ignore') return;

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
      const handle = await startTurnStream(projectId, teamId, event, 'On it');
      if (handle) {
        handle.sessionId = existing.sessionId;
        activeStreams.set(existing.sessionId, handle);
      }
      const outcome = await deliverFollowUpToSandbox(existing.sessionId, envelope, event);
      if (outcome === 'delivered') {
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
      if (handle) {
        activeStreams.delete(existing.sessionId);
        await finalizeStream(handle, { error: "I couldn't reach the sandbox — try again." });
      }
      if (outcome === 'transient') return;
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

  const handle = await startTurnStream(projectId, teamId, event, 'Spinning up a sandbox');

  const result = await createProjectSession({
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: renderAgentPrompt(envelope, event, revived),
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
    // Sandbox-side env the slack skill references. The agent uses these to
    // talk back to the same thread without parsing IDs out of the prompt.
    extraEnvVars: buildSlackTurnEnv(teamId, event),
  });

  if (result.error) {
    console.error('[slack-webhook] createProjectSession failed', result.error.body);
    if (handle) {
      await finalizeStream(handle, { error: "I couldn't start up just now — try again in a moment." });
    }
    return;
  }

  if (result.row && handle) {
    handle.sessionId = result.row.sessionId;
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

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- **First, load the `slack` skill** via the `skill` tool. It is the canonical',
  '  reference for posting in Slack — covers step/send semantics, link syntax,',
  '  Block Kit answers, sources, tone, and gotchas. Do not skip it.',
  '- As you go, post a short progress checkpoint before each major step:',
  '    slack step "Reading the incident logs"',
  '  Keep them human and brief — a few per task, not one per command.',
  '- Attach inline context with mrkdwn links:',
  '    slack step "Reading the logs" --detail "Pulling from <https://datadog.example.com|Datadog>"',
  '  `--detail` is the subtitle under the new step. `<url|label>` becomes a real link.',
  '- When the PREVIOUS step finished with a result, surface it:',
  '    slack step "Drafting summary" --output "Found 3 incidents, 1 P0"',
  '  Add `--source URL|TITLE` (repeatable) to cite the URLs you used.',
  '- **Any time you would ask the user a question, use the built-in `question` tool — NEVER `slack send`.**',
  '  If your reply would contain a `?` or any "please tell me / choose / which one / what',
  '  would you like" phrasing, that is a question and it MUST go through `question`.',
  '  `slack send` is for the FINAL ANSWER only, never for prompts.',
  '  The `question` tool takes an `Array<QuestionInfo>` per opencode\'s schema — each',
  '  with { question, header, options[], multiple, custom }. On Slack turns the sandbox',
  '  automatically renders a Block Kit form (radio/checkboxes/text) in the same thread',
  '  and resumes the tool with the user\'s answers (`string[][]` — one array per question).',
  '  WRONG:  `slack send --blocks-file questions.json` (non-interactive — they can\'t reply!)',
  '  RIGHT:  call the `question` tool with one or more QuestionInfo entries.',
  '  Load the `slack` skill (`<asking-the-user>`) for the QuestionInfo schema + examples.',
  '- Deliver the answer as a rich Block Kit message whenever the response',
  '  benefits from structure (headers, sections, lists, links, bullets):',
  '    slack send --text "fallback summary" --blocks-file /tmp/answer.json',
  '  The `blocks` JSON follows the Block Kit schema (header, section with mrkdwn,',
  '  divider, context, image, actions). Plain text via `slack send "..."` is fine',
  '  for one-liners, but prefer blocks when there\'s real structure to convey.',
  '- One `slack send` per turn. It finalizes the live stream and can\'t be undone.',
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
  tab?: 'home' | 'messages';
}

interface SlackInteractionPayload {
  type: string;
  team?: { id: string };
  user?: { id: string };
  channel?: { id: string };
  message?: { ts: string; thread_ts?: string };
  actions?: Array<{
    action_id?: string;
    value?: string;
    text?: { type?: string; text?: string };
    // static_select fires block_actions with the picked option here.
    selected_option?: { value?: string; text?: { text?: string } } | null;
  }>;
  response_url?: string;
  state?: {
    values?: Record<
      string,
      Record<
        string,
        {
          type?: string;
          value?: string;
          selected_option?: { value?: string } | null;
          selected_options?: Array<{ value?: string }>;
        }
      >
    >;
  };
}
