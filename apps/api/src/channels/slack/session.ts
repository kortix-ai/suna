import { and, eq } from 'drizzle-orm';
import { chatEventDedup, chatThreads, projectSessions, projects } from '@kortix/db';
import { slackFollowUpHeader, slackPlainText } from '@kortix/shared';
import { db } from '../../lib/db';
import { config } from '../../lib/config';
import { filterAccessibleObjects } from '../../iam';
import { actorForUser } from '../../iam/actor';
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { normalizeString } from '../../projects/lib/serializers';
import { chooseEffectiveAgent } from '../../llm-gateway/resolution/effective';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { buildAgentUnavailablePickerBlocks, loadScopedChannelAgents } from './agent-picker';
import { currentChannelSelection } from './selection';
import { startErrorMessage } from './start-error';
import {
  normalizeConversationPolicy,
  rememberSlackThreadOwner,
} from './participants';
import {
  buildSlackTurnEnv,
  finalizeTurn,
  saveTurn,
  showStopOnLivePlan,
  startTurn,
} from './turn';
import type { SlackEnvelope, SlackEvent } from './types';
import { slackMessageLabels, type SlackMessageLabels } from './labels';
import { promptModelOverride } from '../vision-model';
import {
  type ChannelModelScope,
  agentGrantEnvFor,
  planChannelFollowUp,
  planChannelSessionStart,
  projectChannelModelScope,
} from '../model-access';

const defaultSlackSessionLifecycle = {
  continueSession: continueLifecycleSession,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
};

let slackSessionLifecycle = defaultSlackSessionLifecycle;

export function setSlackSessionLifecycleForTest(overrides: Partial<typeof defaultSlackSessionLifecycle>) {
  slackSessionLifecycle = { ...defaultSlackSessionLifecycle, ...overrides };
}

export function resetSlackSessionLifecycleForTest() {
  slackSessionLifecycle = defaultSlackSessionLifecycle;
}

export async function deliverSlackFollowUpToSession(input: {
  sessionId: string;
  text: string;
  userId?: string | null;
  /** This turn only — see channels/vision-model.ts. */
  model?: string | null;
}) {
  return slackSessionLifecycle.continueSession({
    source: 'slack',
    sessionId: input.sessionId,
    text: input.text,
    userId: input.userId,
    ...(input.model ? { overrides: { model: promptModelOverride(input.model) } } : {}),
  });
}

/** Does this Slack message carry an image the model has to be able to see? */
export function slackMessageHasImage(event: SlackEvent): boolean {
  return (event.files ?? []).some((f) => f.mimetype?.startsWith('image/') === true);
}

/** DMs are private only when Slack users have their own identities. */
export function slackSessionIsPersonal(event: SlackEvent): boolean {
  return config.SLACK_REQUIRE_USER_IDENTITY && event.channel_type === 'im';
}

/** The model scope of a Slack turn run as `userId` (see channels/model-access.ts). */
async function slackTurnScope(
  project: { projectId: string; accountId: string; metadata: unknown },
  event: SlackEvent,
  userId: string,
): Promise<ChannelModelScope | null> {
  return projectChannelModelScope(project, {
    linkedUserId: config.SLACK_REQUIRE_USER_IDENTITY ? userId : null,
    oneToOne: slackSessionIsPersonal(event),
  }).catch((err) => {
    console.warn('[slack-webhook] model scope unavailable; the legacy model check applies', err);
    return null;
  });
}

/** Keep a thread’s model unless it can no longer run. */
export async function slackFollowUpModel(input: {
  project: { projectId: string; accountId: string; metadata: unknown };
  userId: string;
  sessionId: string;
  event: SlackEvent;
  /** The session row, when the caller already read it. */
  session?: { createdBy: string | null; metadata: unknown; agentName: string | null };
}): Promise<string | null> {
  const row =
    input.session ??
    (
      await db
        .select({ metadata: projectSessions.metadata, createdBy: projectSessions.createdBy, agentName: projectSessions.agentName })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, input.sessionId))
        .limit(1)
    )[0];
  const pinned = (row?.metadata as Record<string, unknown> | null)?.opencode_model;
  return planChannelFollowUp({
    projectId: input.project.projectId,
    accountId: input.project.accountId,
    userId: input.userId,
    scope: await slackTurnScope(input.project, input.event, input.userId),
    session: {
      sessionId: input.sessionId,
      ownerUserId: row?.createdBy ?? null,
      pinnedModel: typeof pinned === 'string' && pinned.trim() ? pinned.trim() : null,
    },
    chosenModel: null,
    hasImage: slackMessageHasImage(input.event),
    agentGrantEnv: agentGrantEnvFor(input.project.projectId, row?.agentName),
  });
}

// Claim a new thread before creating its session; concurrent messages join it.
export async function createOrJoinThreadSession(input: {
  projectId: string;
  teamId: string;
  threadId: string;
  envelope: SlackEnvelope;
  event: SlackEvent;
  revived: boolean;
  // Verified linked user; run with their credentials, not the account owner’s.
  actorUserId: string;
}): Promise<void> {
  const { projectId, teamId, threadId, event, actorUserId } = input;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  const userId = actorUserId;

  const claimKey = await joinExistingThread(project, input);
  if (claimKey === undefined) return;

  const handle = await startTurn(projectId, teamId, event, 'Spinning up a sandbox');

  const launch = await planSlackLaunch(project, event, teamId, userId, handle);
  if (!launch) {
    if (claimKey) await releaseThreadCreate(claimKey);
    return;
  }
  const { selection } = launch;

  const result = await launchSlackSession(project, input, launch, claimKey);

  if (result.error) {
    await reportSlackStartError(result.error, input, selection?.agentName ?? null, handle, claimKey);
    return;
  }

  if (result.status === 'queued' || result.status === 'pending') {
    if (handle) {
      await finalizeTurn(handle, { answer: queuedMessage() });
    }
    return;
  }

  if (result.sessionId && handle) {
    handle.sessionId = result.sessionId;
    await saveTurn(handle);
    // Stop is only paintable once the message knows which session it would end.
    await showStopOnLivePlan(handle);
  }
  if (result.sessionId && teamId && threadId && event.user) {
    await rememberSlackThreadOwner({
      teamId,
      threadId,
      sessionId: result.sessionId,
      slackUserId: event.user,
      userId,
    });
  }
}

async function reportSlackStartError(
  error: NonNullable<Awaited<ReturnType<typeof slackSessionLifecycle.createSession>>['error']>,
  { projectId, teamId, event }: Parameters<typeof createOrJoinThreadSession>[0],
  selectedAgent: string | null,
  handle: Awaited<ReturnType<typeof startTurn>>,
  claimKey: string | null,
) {
  console.error('[slack-webhook] createProjectSession failed', { status: error.status, body: error.body });
  // Release the claim so a corrected re-send can start immediately.
  if (claimKey) await releaseThreadCreate(claimKey);
  if (handle) {
    // A missing agent needs a picker, not a generic retry.
    if (error.body?.code === 'AGENT_NOT_DECLARED' && event.channel) {
      const agents = await loadScopedChannelAgents({ teamId, projectId, slackUserId: event.user ?? undefined });
      await finalizeTurn(handle, {
        title: "Couldn't start — pick an agent",
        error: "I couldn't start a session — the agent set for this channel no longer exists. Pick a current agent, then send your message again.",
        blocks: buildAgentUnavailablePickerBlocks({
          channelId: event.channel,
          badAgent: selectedAgent,
          agents,
        }),
      });
    } else {
      await finalizeTurn(handle, { error: startErrorMessage(error.status, error.body) });
    }
  }
}

async function launchSlackSession(
  project: typeof projects.$inferSelect,
  { projectId, teamId, threadId, envelope, event, revived, actorUserId: userId }: Parameters<typeof createOrJoinThreadSession>[0],
  { conversationPolicy, launchAgent, start }: NonNullable<Awaited<ReturnType<typeof planSlackLaunch>>>,
  claimKey: string | null,
) {
  const labels = await slackMessageLabels({ projectId, teamId, event });
  return slackSessionLifecycle.createSession({
    source: 'slack',
    project,
    userId,
    requestingPrincipalType: 'human',
    body: {
      base_ref: project.defaultBranch,
      agent_name: launchAgent,
      ...(start.model ? { opencode_model: start.model } : {}),
      ...(start.pools ? { provider_secret_pools: start.pools } : {}),
      initial_prompt: renderAgentPrompt(envelope, event, revived, labels),
      // Keep scaffolded prompt details out of the project-visible title, and
      // Slack markup with them: `<@U0…>` reads `@Sam`, as Slack shows it.
      title_source: event.text ? slackPlainText(labels.text) : null,
    },
    queuePolicy: 'on_backpressure',
    // Per-message key allows retry after a failed first start; claim serializes races.
    idempotencyKey: teamId && threadId && event.ts ? `slack:create:${teamId}:${threadId}:${event.ts}` : claimKey,
    postCreate: teamId && threadId
      ? [{ type: 'bind_chat_thread', platform: 'slack', workspaceId: teamId, threadId }]
      : undefined,
    visibility: slackSessionIsPersonal(event) ? 'private' : conversationPolicy === 'project_open' ? 'project' : 'restricted',
    metadata: {
      source: 'slack',
      slack: {
        team_id: teamId,
        channel: event.channel,
        user: event.user,
        thread_ts: threadId,
        event_type: event.type,
        conversation_policy: conversationPolicy,
        ...(labels.channel ? { channel_label: labels.channel } : {}),
        ...(labels.user ? { user_name: labels.user } : {}),
      },
    },
    extraEnvVars: buildSlackTurnEnv(teamId, event),
  });
}

async function planSlackLaunch(
  project: typeof projects.$inferSelect,
  event: SlackEvent,
  teamId: string,
  userId: string,
  handle: Awaited<ReturnType<typeof startTurn>>,
) {
  const projectId = project.projectId;
  const selection = event.channel
    ? await currentChannelSelection({ teamId, channelId: event.channel })
    : null;
  const conversationPolicy = normalizeConversationPolicy(selection?.conversationPolicy);

  // Resolve the configured default before checking agent access.
  const projectDefaultAgent = normalizeString(
    (project.metadata as Record<string, unknown> | null | undefined)?.default_agent,
  );
  const launchAgent = chooseEffectiveAgent({
    explicit: selection?.agentName ?? null,
    projectDefault: projectDefaultAgent,
  }).agent;
  const allowedAgents = await filterAccessibleObjects(
    actorForUser(userId, project.accountId),
    projectId,
    'agent',
    [launchAgent],
  );
  if (allowedAgents.length === 0) {
    if (handle) {
      await finalizeTurn(handle, {
        error: `You don't have access to the \`${launchAgent}\` agent in this project. Ask a project manager to grant it, or switch the agent with \`/kortix agents\`.`,
      });
    }
    return null;
  }

  const start = await planChannelSessionStart({
    projectId,
    accountId: project.accountId,
    userId,
    scope: await slackTurnScope(project, event, userId),
    chosenModel: selection?.opencodeModel,
    agentName: launchAgent,
    hasImage: slackMessageHasImage(event),
    agentGrantEnv: agentGrantEnvFor(projectId, launchAgent),
  });

  if (start.unavailableModel) {
    if (handle) await finalizeTurn(handle, {
      title: 'Model unavailable',
      error: `The model \`${start.unavailableModel}\` isn't available. Pick another model with \`/kortix models\`, then send your message again.`,
    });
    return null;
  }

  return { selection, conversationPolicy, launchAgent, start };
}

/** Return undefined when a mapped thread took the follow-up; otherwise its claim key. */
async function joinExistingThread(
  project: typeof projects.$inferSelect,
  { projectId, teamId, threadId, envelope, event, actorUserId }: Parameters<typeof createOrJoinThreadSession>[0],
): Promise<string | null | undefined> {
  // Claim the thread-create. Losers wait; winners check for a mapping left
  // by a prior claim before creating another session.
  const claimKey = teamId && threadId ? `slack:threadcreate:${teamId}:${threadId}` : null;
  const lostClaim = !!claimKey && !(await claimThreadCreate(claimKey));
  const sessionId = teamId && threadId
    ? await waitForThreadSession(teamId, threadId, projectId, lostClaim ? 8_000 : 0)
    : null;
  if (sessionId) {
    await deliverSlackFollowUpToSession({
      sessionId,
      text: renderFollowUpPrompt(envelope, event, await slackMessageLabels({ projectId, teamId, event })),
      userId: actorUserId,
      model: await slackFollowUpModel({ project, userId: actorUserId, sessionId, event }),
    });
    return undefined;
  }
  if (lostClaim) {
    console.warn('[slack-webhook] lost thread-create claim but winner never published a session', {
      teamId,
      threadId,
    });
    return undefined;
  }

  return claimKey;
}

function queuedMessage(): string {
  return "I've queued your task behind the sessions already starting up in this project, and I'll reply right here the moment it begins.";
}

// Fail open on DB errors rather than dropping a message.
async function claimThreadCreate(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[slack-webhook] thread-create claim failed (fail-open)', err);
    return true;
  }
}

async function releaseThreadCreate(key: string): Promise<void> {
  try {
    await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, key));
  } catch (err) {
    // The claim still expires on its own; only the retry window stays shut.
    console.warn('[slack-webhook] thread-create claim release failed', err);
  }
}

// Wait briefly for the claim winner to publish its chat_threads mapping so a
// losing concurrent message can be delivered into the same session as a
// follow-up instead of spawning a competitor.
async function waitForThreadSession(teamId: string, threadId: string, projectId: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [row] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'slack'),
          eq(chatThreads.workspaceId, teamId),
          eq(chatThreads.threadId, threadId),
          eq(chatThreads.projectId, projectId),
        ),
      )
      .limit(1);
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const TURN_INSTRUCTIONS = [
  'How to work:',
  '- **First, load the `kortix-slack` skill** via the `skill` tool. It is the canonical',
  '  reference for posting in Slack — covers step/send semantics, link syntax,',
  '  Block Kit answers, sources, tone, and gotchas. Do not skip it.',
  '- The `slack` CLI needs **no token** in your sandbox — every command runs through the',
  '  Kortix Connector (the Slack bot token is resolved server-side). The whole surface',
  '  works, **including `slack send --file` (file upload) and `slack download`**. Do NOT',
  '  conclude "file upload isn\'t supported", do NOT look for `$SLACK_BOT_TOKEN`, and do',
  '  NOT build an upload workaround (connector/MCP, manual files.getUploadURLExternal, an',
  '  HTTP link host) — `slack send --file <path> --channel ... --thread ...` just works.',
  '- As you go, post a short progress checkpoint before each major step:',
  '    slack step "Reading the incident logs"',
  '  Keep them human and brief — a few per task, not one per command — but DO post',
  '  one right before anything slow (installs, builds, long searches, big edits) so',
  '  the thread always shows fresh, lively progress and never sits silent.',
  '- Attach inline context with mrkdwn links:',
  '    slack step "Reading the logs" --detail "Pulling from <https://datadog.example.com|Datadog>"',
  '  `--detail` is the subtitle under the new step. `<url|label>` becomes a real link.',
  '- When the PREVIOUS step finished with a result, surface it:',
  '    slack step "Drafting summary" --output "Found 3 incidents, 1 P0"',
  '  Add `--source URL|TITLE` (repeatable) to cite the URLs you used.',
  '- **Need to ask the user something with DISCRETE choices? Use the built-in `question`',
  '  tool.** It renders real Block Kit buttons — one per option — and a click resumes the',
  '  thread on the next turn. It does NOT block and does NOT fail: it returns immediately,',
  '  and you END your turn. The answer arrives as a fresh turn with full context.',
  '- Use `slack send` for a question only when it is genuinely open-ended prose with',
  '  nothing to pick from. A numbered list of choices in a message is the wrong shape —',
  '  the user cannot click it. Never sit waiting for an answer inside a turn.',
  '- Deliver the answer as a rich Block Kit message whenever the response',
  '  benefits from structure (headers, sections, lists, links, bullets):',
  '    slack send --text "fallback summary" --blocks-file /tmp/answer.json',
  '  The `blocks` JSON follows the Block Kit schema (header, section with mrkdwn,',
  '  divider, context, image, actions). Plain text via `slack send "..."` is fine',
  '  for one-liners, but prefer blocks when there\'s real structure to convey.',
  '- One `slack send` per turn. It finalizes the live stream and can\'t be undone.',
].join('\n');

function renderFileInfo(event: SlackEvent): string {
  if (!event.files?.length) return '';
  const lines: string[] = ['', 'The user also attached files:'];
  for (const file of event.files) {
    const name = file.name ?? file.title ?? file.id;
    lines.push(`  • ${name} (${file.mimetype}, ${file.filetype}, ${formatFileSize(file.size)})`);
    lines.push(`    Download: ${file.url_private_download}`);
  }
  lines.push('', 'Use `slack download --url "<url>" --out <path>` to download each file.');
  lines.push('For audio files, process them as needed (e.g. transcribe with whisper or another ASR tool).');
  return lines.join('\n');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `Sam Rivera (U0…)` when the label is known, else the id alone. */
function labelled(label: string | null | undefined, id: string): string {
  return label ? `${label} (${id})` : id;
}

export function renderFollowUpPrompt(envelope: SlackEnvelope, event: SlackEvent, labels?: SlackMessageLabels): string {
  const user = labelled(labels?.user, event.user ?? 'unknown');
  const channel = labelled(labels?.channel, event.channel ?? 'unknown');
  const text = labels?.text ?? event.text ?? '';
  return [
    // The session page reads this line back with `readSlackFollowUpHeader`.
    slackFollowUpHeader(user, channel, event.thread_ts ?? event.ts ?? 'unknown'),
    'This session may serve several threads. Reply to THIS message in its originating channel and thread:',
    `slack send --channel ${event.channel ?? 'unknown'} --thread ${event.thread_ts ?? event.ts ?? 'unknown'} --text "<answer>"`,
    'The live slack step stream follows this message automatically. Do not use the session\'s original Slack thread for this reply.',
    '',
    text,
    renderFileInfo(event),
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(
  envelope: SlackEnvelope,
  event: SlackEvent,
  revived: boolean,
  labels?: SlackMessageLabels,
): string {
  const channel = labelled(labels?.channel, event.channel ?? '?');
  const threadTs = event.thread_ts ?? event.ts ?? '';
  const user = labelled(labels?.user, event.user ?? 'unknown');
  const text = labels?.text ?? event.text ?? '';

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
  lines.push('', 'Message:', text, renderFileInfo(event), '', TURN_INSTRUCTIONS);
  return lines.join('\n');
}
