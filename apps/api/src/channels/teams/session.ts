import { and, eq } from 'drizzle-orm';
import { chatEventDedup, chatThreads, projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { currentChannelSelection } from '../slack/selection';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { ensureTeamsConversationBinding, teamsChannelCtx } from './binding';
import { postTeamsIdentityPrompt, resolveTeamsActor, teamsUserId } from './identity';
import {
  buildTeamsTurnEnv,
  closeAbandonedTurn,
  deleteTurn,
  finalizeTurn,
  loadTurn,
  noticeOnLiveCard,
  persistServiceUrl,
  saveTurn,
  startTurn,
} from './turn';
import { sessionWebUrl } from '../slack/util';
import { channelTurnModel, promptModelOverride } from '../vision-model';
import {
  extractTeamsAttachments,
  teamsMessageHasImage,
  type TeamsActivity,
  type TeamsLiveTurn,
} from './types';
import { describeTeamsConversation, stripTeamsMentions } from './util';
import { ensureTeamsThreadParticipant, normalizeConversationPolicy, rememberTeamsThreadOwner } from './participants';

const defaultTeamsSessionLifecycle = {
  continueSession: continueLifecycleSession,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
};

let teamsSessionLifecycle = defaultTeamsSessionLifecycle;

export function setTeamsSessionLifecycleForTest(overrides: Partial<typeof defaultTeamsSessionLifecycle>) {
  teamsSessionLifecycle = { ...defaultTeamsSessionLifecycle, ...overrides };
}

export function resetTeamsSessionLifecycleForTest() {
  teamsSessionLifecycle = defaultTeamsSessionLifecycle;
}

async function resolveTeamsTurnActor(
  accountId: string,
  projectId: string,
  tenantId: string,
  activity: TeamsActivity,
  liveCardActivityId: string | undefined,
): Promise<string | null> {
  if (!config.TEAMS_REQUIRE_USER_IDENTITY) {
    const userId = await teamsSessionLifecycle.resolveProjectAutomationActor(accountId);
    if (!userId) console.warn('[teams-webhook] no actor for project', projectId);
    return userId;
  }

  const senderId = teamsUserId(activity);
  const actor = await resolveTeamsActor(tenantId, senderId ?? '', accountId, projectId);
  if ('userId' in actor) return actor.userId;

  // The live card is already on screen (it goes out before identity is
  // known); the prompt takes its place instead of stacking underneath.
  await postTeamsIdentityPrompt({
    projectId,
    tenantId,
    activity,
    reason: actor.reason,
    ...(liveCardActivityId ? { replaceActivityId: liveCardActivityId } : {}),
  }).catch((err) => console.warn('[teams-webhook] failed to post identity prompt', err));
  return null;
}

/** True when a session is already bound to this conversation (a thread the bot owns). */
export async function hasConversationSession(tenantId: string, conversationId: string): Promise<boolean> {
  if (!tenantId || !conversationId) return false;
  const [row] = await db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'teams'),
        eq(chatThreads.workspaceId, tenantId),
        eq(chatThreads.threadId, conversationId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function deliverTeamsFollowUpToSession(input: {
  sessionId: string;
  text: string;
  userId?: string | null;
  /** This turn only — see channels/vision-model.ts. */
  model?: string | null;
}) {
  return teamsSessionLifecycle.continueSession({
    source: 'teams',
    sessionId: input.sessionId,
    text: input.text,
    userId: input.userId,
    ...(input.model ? { overrides: { model: promptModelOverride(input.model) } } : {}),
  });
}

/** The model this session is pinned to, as `createProjectSession` recorded it. */
function sessionModelOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.opencode_model;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function bindTurnToSession(handle: TeamsLiveTurn | null, sessionId: string): Promise<void> {
  if (!handle) return;
  handle.sessionId = sessionId;
  await saveTurn(handle);
}

const ERROR_NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** One failure notice per conversation: a jammed thread must not repeat the same line on every message. */
async function claimConversationErrorNotice(tenantId: string, conversationId: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: `teams:threaderror:${tenantId}:${conversationId}`,
        expiresAt: new Date(Date.now() + ERROR_NOTICE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[teams-webhook] error-notice claim failed (suppressing notice)', err);
    return false;
  }
}

async function clearConversationErrorNotice(tenantId: string, conversationId: string): Promise<void> {
  await db
    .delete(chatEventDedup)
    .where(eq(chatEventDedup.eventId, `teams:threaderror:${tenantId}:${conversationId}`))
    .catch(() => {});
}

/**
 * Hand a follow-up to the session this conversation is bound to, and render
 * the outcome on the live card. Returns `'revive'` when the session is gone
 * for good and the caller should drop the mapping and create a new one —
 * every other outcome ends here.
 *
 * Mirrors channels/slack/dispatch.ts: a known conversation maps PERMANENTLY
 * to one session; `pending` and `failed` keep the mapping (recreating is how
 * a real session gets orphaned), only a deleted session (`no-session`) is
 * replaced.
 */
/**
 * How long a turn may go without writing a step and still count as "in
 * flight". Past this the row is treated as abandoned even if the session row
 * still claims to be running — a wedged conversation is worse than a
 * duplicate card.
 */
const TURN_LIVE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Is this turn actually still streaming? `finalized: false` alone is not
 * enough: a sandbox that dies mid-turn never relays `turn_end`, leaving a row
 * that looks live forever. Such a zombie used to swallow every later message
 * behind "I'll take this after the current step" until the 30-minute sweeper
 * ran (dev, 2026-09-18). A turn counts as live only while its session is
 * running AND the row has moved recently.
 */
function turnIsLive(turn: TeamsLiveTurn | null, sessionStatus: string | null): boolean {
  if (!turn || turn.finalized) return false;
  if (sessionStatus !== 'running') return false;
  const movedAt = turn.updatedAt ?? 0;
  return Date.now() - movedAt < TURN_LIVE_WINDOW_MS;
}

async function deliverFollowUp(input: {
  projectId: string;
  accountId: string;
  tenantId: string;
  conversationId: string;
  sessionId: string;
  sessionOwnerId: string | null;
  sessionMetadata: Record<string, unknown> | null;
  sessionStatus: string | null;
  handle: TeamsLiveTurn | null;
  activity: TeamsActivity;
  userId: string;
}): Promise<'done' | 'revive'> {
  const { projectId, tenantId, conversationId, sessionId, activity, userId } = input;
  let handle = input.handle;

  // Who may continue this session (owner-only / owner-approval / open). The
  // verdict's notice replaces the requester's own live card; nothing reaches
  // the session until they are allowed in.
  if (config.TEAMS_REQUIRE_USER_IDENTITY && activity.serviceUrl) {
    const selection = await currentChannelSelection(teamsChannelCtx(tenantId, conversationId));
    const verdict = await ensureTeamsThreadParticipant({
      projectId,
      tenantId,
      conversationId,
      sessionId,
      sessionOwnerId: input.sessionOwnerId,
      sessionMetadata: input.sessionMetadata,
      channelPolicy: selection?.conversationPolicy,
      teamsUserId: teamsUserId(activity) ?? '',
      requesterName: activity.from?.name ?? 'Someone',
      actorUserId: userId,
      ref: {
        serviceUrl: activity.serviceUrl,
        conversationId,
        botId: activity.recipient?.id,
        fromId: activity.from?.id,
        tenantId,
        projectId,
      },
    });
    if (!verdict.allowed) {
      if (handle) await noticeOnLiveCard(handle, verdict.notice);
      return 'done';
    }
  }

  const inflight = await loadTurn(sessionId);
  if (turnIsLive(inflight, input.sessionStatus)) {
    // A turn really is streaming: the running stream keeps its card, ours
    // becomes a short notice and is not saved as the turn.
    if (handle) await noticeOnLiveCard(handle, 'Got it — I’ll take this after the current step.');
    handle = null;
  } else {
    // Either no turn, or one that stopped without finishing. Close the dead
    // card so the conversation is not wedged behind it, then take over.
    if (inflight && !inflight.finalized) await closeAbandonedTurn(inflight);
    await bindTurnToSession(handle, sessionId);
  }

  // An image is unreadable on a text-only model, so THIS turn runs on the
  // configured vision model. The session's own pin is untouched.
  const turnModel = await channelTurnModel({
    projectId,
    accountId: input.accountId,
    userId,
    currentModel: sessionModelOf(input.sessionMetadata),
    hasImage: teamsMessageHasImage(activity),
  });
  const outcome = await deliverTeamsFollowUpToSession({
    sessionId,
    text: renderFollowUpPrompt(activity),
    userId,
    model: turnModel,
  });

  if (outcome === 'delivered') {
    await db
      .update(chatThreads)
      .set({ lastMessageAt: new Date() })
      .where(
        and(
          eq(chatThreads.platform, 'teams'),
          eq(chatThreads.workspaceId, tenantId),
          eq(chatThreads.threadId, conversationId),
        ),
      );
    return 'done';
  }

  if (outcome === 'pending' || outcome === 'not-landed') {
    if (handle) {
      await deleteTurn(sessionId);
      await finalizeTurn(handle, {
        error: "Still waking this conversation's session back up — send that again in a moment.",
      });
    }
    return 'done';
  }

  if (outcome === 'failed' || outcome === 'unreachable') {
    if (handle) {
      await deleteTurn(sessionId);
      if (await claimConversationErrorNotice(tenantId, conversationId)) {
        const url = sessionWebUrl(config.FRONTEND_URL, projectId, sessionId);
        await finalizeTurn(handle, {
          error: `This conversation's session hit an error and couldn't start. [Open it in Kortix](${url}) to see what happened.`,
        });
      } else {
        await finalizeTurn(handle, {});
      }
    }
    return 'done';
  }

  // outcome === 'no-session': the session row is gone (deleted). Drop the
  // stale mapping so the caller creates a fresh session on the same card.
  console.warn('[teams-webhook] conversation mapped to a deleted session — replacing', { tenantId, conversationId, sessionId });
  if (handle) await deleteTurn(sessionId);
  await db
    .delete(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'teams'),
        eq(chatThreads.workspaceId, tenantId),
        eq(chatThreads.threadId, conversationId),
      ),
    );
  await clearConversationErrorNotice(tenantId, conversationId);
  return 'revive';
}

export async function createOrJoinTeamsConversationSession(input: {
  projectId: string;
  tenantId: string;
  conversationId: string;
  activity: TeamsActivity;
}): Promise<void> {
  const { projectId, tenantId, conversationId, activity } = input;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  // Time-to-first-card: the "Working on it…" card depends on nothing below
  // this line, so it is posted before the identity link, the membership
  // check and the thread lookup. Everything that follows either binds this
  // handle to a session or replaces the card in place.
  const handle = await startTurn(projectId, tenantId, activity);
  void persistServiceUrl(projectId, activity.serviceUrl);

  const userId = await resolveTeamsTurnActor(
    project.accountId,
    projectId,
    tenantId,
    activity,
    handle?.messageActivityId || undefined,
  );
  if (!userId) return;

  let revived = false;
  if (tenantId && conversationId) {
    const [existing] = await db
      .select({
        sessionId: chatThreads.sessionId,
        createdBy: projectSessions.createdBy,
        metadata: projectSessions.metadata,
        status: projectSessions.status,
      })
      .from(chatThreads)
      .innerJoin(projectSessions, eq(projectSessions.sessionId, chatThreads.sessionId))
      .where(
        and(
          eq(chatThreads.platform, 'teams'),
          eq(chatThreads.workspaceId, tenantId),
          eq(chatThreads.threadId, conversationId),
        ),
      )
      .limit(1);
    if (existing) {
      const next = await deliverFollowUp({
        projectId,
        accountId: project.accountId,
        tenantId,
        conversationId,
        sessionId: existing.sessionId,
        sessionOwnerId: existing.createdBy ?? null,
        sessionMetadata: (existing.metadata as Record<string, unknown> | null) ?? null,
        sessionStatus: (existing.status as string | null) ?? null,
        handle,
        activity,
        userId,
      });
      if (next === 'done') return;
      revived = true;
    }
  }

  const claimKey = tenantId && conversationId ? `teams:threadcreate:${tenantId}:${conversationId}` : null;
  if (claimKey && !(await claimThreadCreate(claimKey))) {
    const sessionId = await waitForConversationSession(tenantId, conversationId);
    if (sessionId) {
      const [row] = await db
        .select({ createdBy: projectSessions.createdBy, metadata: projectSessions.metadata, status: projectSessions.status })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      await deliverFollowUp({
        projectId,
        accountId: project.accountId,
        tenantId,
        conversationId,
        sessionId,
        sessionOwnerId: row?.createdBy ?? null,
        sessionMetadata: (row?.metadata as Record<string, unknown> | null) ?? null,
        sessionStatus: (row?.status as string | null) ?? null,
        handle,
        activity,
        userId,
      });
    } else {
      console.warn('[teams-webhook] lost thread-create claim but winner never published a session', {
        tenantId,
        conversationId,
      });
      if (handle) await finalizeTurn(handle, { error: startErrorMessage(undefined) });
    }
    return;
  }

  await ensureTeamsConversationBinding({ projectId, tenantId, conversationId, ...describeTeamsConversation(activity) });
  const selection = await currentChannelSelection(teamsChannelCtx(tenantId, conversationId));

  // A conversation that OPENS with an image has to start on a model that can
  // read one, and a `/model` pick that has since been retired has to be
  // replaced — the session pin is what every later turn inherits.
  const createModel =
    (await channelTurnModel({
      projectId,
      accountId: project.accountId,
      userId,
      currentModel: selection?.opencodeModel,
      hasImage: teamsMessageHasImage(activity),
    })) ?? selection?.opencodeModel;

  const result = await teamsSessionLifecycle.createSession({
    source: 'teams',
    project,
    userId,
    requestingPrincipalType: 'human',
    body: {
      base_ref: project.defaultBranch,
      agent_name: selection?.agentName || 'default',
      ...(createModel ? { opencode_model: createModel } : {}),
      initial_prompt: renderAgentPrompt(activity, revived),
      // Title from the user's actual words — without the `<at>…</at>` mention
      // markup Teams wraps around the bot's name in channels.
      title_source: activity.text ? stripTeamsMentions(activity.text) || null : null,
    },
    enforceAccountCap: false,
    queuePolicy: 'on_backpressure',
    idempotencyKey: claimKey,
    postCreate:
      tenantId && conversationId
        ? [{ type: 'bind_chat_thread', platform: 'teams', workspaceId: tenantId, threadId: conversationId }]
        : undefined,
    visibility: 'project',
    metadata: {
      source: 'teams',
      teams: {
        tenant_id: tenantId,
        conversation_id: conversationId,
        user: activity.from?.id,
        activity_id: activity.id,
        // Frozen at start: a later `/policy` change applies to NEW sessions only.
        conversation_policy: normalizeConversationPolicy(selection?.conversationPolicy),
      },
    },
    extraEnvVars: buildTeamsTurnEnv(tenantId, activity),
  });

  if (result.error) {
    console.error('[teams-webhook] createProjectSession failed', { status: result.error.status, body: result.error.body });
    if (handle) await finalizeTurn(handle, { error: startErrorMessage(result.error.status) });
    return;
  }

  if (result.status === 'queued' || result.status === 'pending') {
    if (handle) await finalizeTurn(handle, { answer: queuedMessage(result.reason) });
    return;
  }

  if (result.sessionId) {
    await bindTurnToSession(handle, result.sessionId);
    const ownerTeamsId = teamsUserId(activity);
    if (ownerTeamsId && tenantId && conversationId) {
      await rememberTeamsThreadOwner({
        tenantId,
        conversationId,
        sessionId: result.sessionId,
        teamsUserId: ownerTeamsId,
        userId,
      }).catch((err) => console.warn('[teams-webhook] remember owner failed', err));
    }
  }
}

function startErrorMessage(status: number | undefined): string {
  if (status === 402) {
    return "This workspace is out of credits, so I can't start a session. Top up in the Kortix dashboard and send your message again.";
  }
  if (status === 429) {
    return 'This workspace is at its concurrent-session limit right now. Close or finish a running session, then send your message again.';
  }
  if (status === 404) {
    return "I couldn't find this project to start a session — it may have been moved or deleted. Reconnect Kortix to this team and try again.";
  }
  return "I couldn't start a session just now. Give it a moment and send your message again — I'll reply right here.";
}

function queuedMessage(reason?: string): string {
  if (reason === 'account session cap') {
    return "This workspace is at its concurrent-session limit, so I've queued your task. I'll start it and reply right here as soon as a slot frees up.";
  }
  return "I've queued your task behind the sessions already starting in this project, and I'll reply right here the moment it begins.";
}

async function claimThreadCreate(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[teams-webhook] thread-create claim failed (fail-open)', err);
    return true;
  }
}

async function waitForConversationSession(tenantId: string, conversationId: string): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const [row] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'teams'),
          eq(chatThreads.workspaceId, tenantId),
          eq(chatThreads.threadId, conversationId),
        ),
      )
      .limit(1);
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- First, load the `kortix-teams` skill via the `skill` tool for the canonical reference on posting in Teams (step/send semantics, Adaptive Cards, tone).',
  '- The `teams` CLI needs no token in your sandbox — every command runs through the Kortix Connector (the bot credential is resolved server-side).',
  '- As you go, post a short progress checkpoint before each major step:',
  '    teams step "Reading the incident logs"',
  '  Keep them human and brief — a few per task — and post one right before anything slow so the conversation always shows fresh progress.',
  '- Attach inline context with `--detail`, and surface a finished step result with `--output`:',
  '    teams step "Drafting summary" --output "Found 3 incidents, 1 P0"',
  '- Need to ask the user something? Use `teams send`, then END your turn — Teams questions are async: ask, stop, and resume when they reply.',
  '- Deliver the final answer with `teams send` (text, or an Adaptive Card via --card-file). One `teams send` per turn — it finalizes the live message.',
].join('\n');

function renderAttachments(activity: TeamsActivity): string[] {
  const attachments = extractTeamsAttachments(activity);
  if (attachments.length === 0) return [];
  const lines = ['', 'Attached files (download with `teams download --url <url> --out <path>`):'];
  for (const a of attachments) {
    const ext = a.fileType ? `.${a.fileType}` : '';
    lines.push(`- ${a.name}${a.isImage ? ' (image)' : ''} — ${a.downloadUrl}`);
    if (a.isImage) {
      lines.push(
        `    teams download --url "${a.downloadUrl}" --out /workspace/attachment${ext || '.png'}`,
      );
    }
  }
  if (attachments.some((a) => a.isImage)) {
    lines.push(
      '',
      'Then open the downloaded image with the `read` tool and answer from what you see.',
      'Do not look for OCR tools — you can read the image directly.',
    );
  }
  return lines;
}

export function renderFollowUpPrompt(activity: TeamsActivity): string {
  const user = activity.from?.name ?? activity.from?.id ?? 'unknown';
  const text = stripTeamsMentions(activity.text ?? '');
  return [
    `New message from ${user} in the same Teams conversation:`,
    '',
    text,
    ...renderAttachments(activity),
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(activity: TeamsActivity, revived = false): string {
  const tenant = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? 'unknown';
  const conversation = activity.conversation?.id ?? '?';
  const user = activity.from?.name ?? activity.from?.id ?? 'unknown';
  const text = stripTeamsMentions(activity.text ?? '');
  return [
    ...(revived
      ? [
          'NOTE: This Teams conversation had an earlier session, but that session',
          'has ended — you do NOT have its history. Open your reply by briefly',
          'saying you are picking the conversation back up without the earlier context.',
          '',
        ]
      : []),
    "You're answering a message on Microsoft Teams as a teammate.",
    '',
    `Tenant:        ${tenant}`,
    `Conversation:  ${conversation}`,
    `User:          ${user}`,
    '',
    'Message:',
    text,
    ...renderAttachments(activity),
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}
