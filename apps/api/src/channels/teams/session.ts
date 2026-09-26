import { and, eq } from 'drizzle-orm';
import { chatEventDedup, chatThreads, projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { sessionHoldsLiveTurn } from '../../projects/session-lifecycle/inbox-admission';
import { currentChannelSelection } from '../slack/selection';
import { startErrorMessage, TEAMS_START_ERROR_COMMANDS } from '../start-error';
import { buildAgentUnavailableCard } from './agent-picker';
import { resolveAgentGrant } from '../../projects/agents';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { ensureTeamsConversationBinding, teamsChannelCtx } from './binding';
import { postTeamsIdentityPrompt, teamsUserId } from './identity';
import { chatUser, resolveChatActor } from '../core/identity';
import {
  type ChatThreadKey,
  dropChatThread,
  findChatThread,
  findChatThreadSession,
  followUpRoute,
  touchChatThread,
} from '../core/threads';
import {
  buildTeamsTurnEnv,
  closeAbandonedTurn,
  deleteTurn,
  finalizeTurn,
  loadTurn,
  noticeOnLiveCard,
  persistServiceUrl,
  saveTurn,
  showStopOnLiveCard,
  startTurn,
} from './turn';
import { sessionWebUrl } from '../slack/util';
import { modelReadsImages, promptModelOverride } from '../vision-model';
import {
  type ChannelModelScope,
  planChannelFollowUp,
  planChannelSessionStart,
  projectChannelModelScope,
} from '../model-access';
import {
  extractTeamsAttachments,
  teamsMessageHasImage,
  type TeamsActivity,
  type TeamsLiveTurn,
} from './types';
import { describeTeamsConversation, isPersonalChat, stripTeamsMentions, teamsMessageText } from './util';
import { ensureTeamsThreadParticipant, normalizeConversationPolicy, rememberTeamsThreadOwner } from './participants';

const defaultTeamsSessionLifecycle = {
  continueSession: continueLifecycleSession,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
  holdsLiveTurn: sessionHoldsLiveTurn,
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
  const actor = await resolveChatActor(chatUser('teams', tenantId, senderId ?? ''), { projectId, accountId });
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

/**
 * True when a session is already bound to this conversation (a thread the bot
 * owns). With `projectId`, only a session of that project counts.
 */
export async function hasConversationSession(
  tenantId: string,
  conversationId: string,
  projectId?: string,
): Promise<boolean> {
  return !!(await findChatThread(conversationThread(tenantId, conversationId), projectId));
}

function conversationThread(tenantId: string, conversationId: string): ChatThreadKey {
  return { platform: 'teams', workspaceId: tenantId, threadId: conversationId };
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

/**
 * The RUNNING AGENT's granted env names, resolved lazily — a `codex/*` model
 * needs `CODEX_AUTH_JSON` there or the gateway refuses the turn. Only called
 * when a codex candidate is actually reached.
 */
function agentGrantEnvFor(
  project: { projectId: string } & Record<string, unknown>,
  agentName: string | null,
): () => Promise<readonly string[] | 'all' | null> {
  return async () => {
    // A resolution failure is NOT "unrestricted": returning an empty list
    // makes `grantAllowsCodex` fail closed, so a turn is never pinned to a
    // ChatGPT-backed model this agent might not be allowed to use.
    const grant = await resolveAgentGrant(agentName || 'default', project as never).catch(() => undefined);
    if (grant === undefined) return [];
    const env = (grant as { env?: readonly string[] | 'all' } | null)?.env;
    return env ?? null;
  };
}

/** The project's default agent, as its manifest mirror records it. */
function projectDefaultAgentOf(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null | undefined)?.default_agent;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The model this session is pinned to, as `createProjectSession` recorded it. */
function sessionModelOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const value = metadata?.opencode_model;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Who a conversation's session is for. A personal chat with the bot is one
 * person's conversation, so its session is private to them, as a web session
 * is by default — and only a private session reaches that person's own API
 * keys and ChatGPT subscription (spec 2026-09-22 §2.3). Group chats and
 * channels stay shared with the project. With `TEAMS_REQUIRE_USER_IDENTITY`
 * off, sessions run as the account owner, not as the person typing, so they
 * stay shared and no one's personal keys count.
 */
function teamsSessionIsPersonal(activity: TeamsActivity): boolean {
  return config.TEAMS_REQUIRE_USER_IDENTITY && isPersonalChat(activity);
}

/** The model scope of a Teams turn run as `userId` (see channels/model-access.ts). */
async function teamsTurnScope(
  project: { projectId: string; accountId: string; metadata: unknown },
  activity: TeamsActivity,
  userId: string,
): Promise<ChannelModelScope | null> {
  return projectChannelModelScope(project, {
    linkedUserId: config.TEAMS_REQUIRE_USER_IDENTITY ? userId : null,
    oneToOne: teamsSessionIsPersonal(activity),
  }).catch((err) => {
    console.warn('[teams-webhook] model scope unavailable; the legacy model check applies', err);
    return null;
  });
}

async function bindTurnToSession(handle: TeamsLiveTurn | null, sessionId: string): Promise<void> {
  if (!handle) return;
  handle.sessionId = sessionId;
  await saveTurn(handle);
  // Stop is only paintable once the card knows which session it would end.
  await showStopOnLiveCard(handle);
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
  /** The project row, for the conversation's model scope. */
  project: { projectId: string; accountId: string; metadata: unknown };
  agentGrantEnv?: () => Promise<readonly string[] | 'all' | null>;
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
  const selection = await currentChannelSelection(teamsChannelCtx(tenantId, conversationId));
  if (config.TEAMS_REQUIRE_USER_IDENTITY && activity.serviceUrl) {
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
  // A card that has not moved for 10 minutes is not proof of a dead run: one
  // long command (a build, a test suite) posts no step while it works. Before
  // closing it as abandoned, ask the runtime's own turn ledger — the authority
  // `GET .../turn` and inbox admission read. Closing a live run's card lost
  // its answer: the card said "ended", and its `teams send` found no turn.
  const live =
    turnIsLive(inflight, input.sessionStatus) ||
    (!!inflight && !inflight.finalized && (await teamsSessionLifecycle.holdsLiveTurn(sessionId).catch(() => false)));
  if (live) {
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
  // Backfill the conversation's display name on every message, not only at
  // session creation: a channel bound before the name was read off the
  // activity showed a raw `19:…@thread.tacv2;messageid=…` in the bindings
  // table forever. The binding helper keeps its own per-process cache, so a
  // settled conversation costs nothing.
  void ensureTeamsConversationBinding({
    projectId,
    tenantId,
    conversationId,
    ...describeTeamsConversation(activity),
  }).catch((err) => console.warn('[teams-webhook] binding backfill failed', err));

  const hasImage = teamsMessageHasImage(activity);
  const currentModel = sessionModelOf(input.sessionMetadata);
  // The conversation's `/model` choice travels with this prompt, with its keys
  // on the session; an unservable model is replaced for this turn.
  const turnModel = await planChannelFollowUp({
    projectId,
    accountId: input.accountId,
    userId,
    scope: await teamsTurnScope(input.project, activity, userId),
    session: { sessionId, ownerUserId: input.sessionOwnerId, pinnedModel: currentModel },
    chosenModel: selection?.opencodeModel,
    hasImage,
    agentGrantEnv: input.agentGrantEnv,
  });
  // Nothing reachable can read the image. Say so in the prompt rather than
  // letting the agent discover it by calling `read` and finding nothing — that
  // is what sent it hunting for ImageMagick and tesseract on 2026-09-19.
  const imagesUnavailable =
    hasImage && !turnModel && !modelReadsImages(projectId, currentModel || undefined);
  const outcome = await deliverTeamsFollowUpToSession({
    sessionId,
    text: renderFollowUpPrompt(activity, imagesUnavailable),
    userId,
    model: turnModel,
  });

  if (outcome === 'delivered') {
    await touchChatThread(conversationThread(tenantId, conversationId));
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
        // The notice is suppressed so a jammed conversation does not repeat
        // the same error line on every message — but the CARD must not then
        // claim "Task complete" over a session that failed to start. Title
        // only: honest, and still silent.
        await finalizeTurn(handle, { title: "Couldn't start", unfinished: true });
      }
    }
    return 'done';
  }

  // outcome === 'no-session': the session row is gone (deleted). Drop the
  // stale mapping so the caller creates a fresh session on the same card.
  console.warn('[teams-webhook] conversation mapped to a deleted session — replacing', { tenantId, conversationId, sessionId });
  if (handle) await deleteTurn(sessionId);
  await dropChatThread(conversationThread(tenantId, conversationId));
  await clearConversationErrorNotice(tenantId, conversationId);
  return 'revive';
}

export async function createOrJoinTeamsConversationSession(input: {
  projectId: string;
  tenantId: string;
  conversationId: string;
  activity: TeamsActivity;
  /**
   * Set by the per-project (BYO) webhook: its activities may reach only its
   * own project, so a conversation another project's session owns is refused.
   */
  ownThreadsOnly?: boolean;
}): Promise<void> {
  const { tenantId, conversationId, activity } = input;
  let projectId = input.projectId;

  let [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  // A conversation's session lives in exactly one project, and a follow-up is
  // delivered THERE — so the sender is authorized against that project, never
  // only against the one the conversation currently resolves to (a `/use`
  // re-points the conversation, but its running session stays where it was
  // created until `/new`).
  const threadProject = (await findChatThread(conversationThread(tenantId, conversationId)))?.projectId;
  const route = followUpRoute(threadProject, projectId, { ownThreadsOnly: input.ownThreadsOnly });
  if (route.kind === 'refused') {
    console.warn('[teams-webhook] conversation session belongs to another project — ignoring', { projectId });
    return;
  }
  if (route.kind === 'thread_project') {
    if (!(await projectFeatureFlagEnabled(route.projectId, 'teams'))) return;
    projectId = route.projectId;
    [project] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!project) return;
  }

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
    const existing = await findChatThreadSession(conversationThread(tenantId, conversationId), projectId);
    if (existing) {
      const next = await deliverFollowUp({
        projectId,
        accountId: project.accountId,
        project,
        // The session's own agent: its secret grant decides which keys it may use.
        agentGrantEnv: agentGrantEnvFor(project, existing.agentName ?? null),
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
    const sessionId = await waitForConversationSession(tenantId, conversationId, projectId);
    if (sessionId) {
      const [row] = await db
        .select({
          createdBy: projectSessions.createdBy,
          agentName: projectSessions.agentName,
          metadata: projectSessions.metadata,
          status: projectSessions.status,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      await deliverFollowUp({
        projectId,
        accountId: project.accountId,
        project,
        agentGrantEnv: agentGrantEnvFor(project, row?.agentName ?? null),
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
      if (handle) await finalizeTurn(handle, { error: startError(undefined, undefined) });
    }
    return;
  }

  await ensureTeamsConversationBinding({ projectId, tenantId, conversationId, ...describeTeamsConversation(activity) });
  const selection = await currentChannelSelection(teamsChannelCtx(tenantId, conversationId));

  // A conversation that OPENS with an image has to start on a model that can
  // read one, and a `/model` pick that has since been retired has to be
  // replaced — the session pin is what every later turn inherits. A pick that
  // runs on provider keys starts with every key this conversation may use.
  const start = await planChannelSessionStart({
    projectId,
    accountId: project.accountId,
    userId,
    scope: await teamsTurnScope(project, activity, userId),
    chosenModel: selection?.opencodeModel,
    agentName: selection?.agentName || projectDefaultAgentOf(project.metadata),
    hasImage: teamsMessageHasImage(activity),
    agentGrantEnv: agentGrantEnvFor(project, selection?.agentName ?? null),
  });
  const createModel = start.model;

  const result = await teamsSessionLifecycle.createSession({
    source: 'teams',
    project,
    userId,
    requestingPrincipalType: 'human',
    body: {
      base_ref: project.defaultBranch,
      agent_name: selection?.agentName || 'default',
      ...(createModel ? { opencode_model: createModel } : {}),
      ...(start.pools ? { provider_secret_pools: start.pools } : {}),
      initial_prompt: renderAgentPrompt(activity, revived),
      // Title from the user's actual words — without the `<at>…</at>` mention
      // markup Teams wraps around the bot's name in channels.
      title_source: activity.text ? stripTeamsMentions(activity.text) || null : null,
    },
    enforceAccountCap: false,
    queuePolicy: 'on_backpressure',
    // One key per inbound message, never per conversation. The lifecycle
    // keeps a key forever (a unique index, no retention) and a chat is one
    // conversation for life, so under the conversation's key its FIRST
    // create_session command answered every later create: a failed first
    // start (dead-lettered) failed every later message with the same error, a
    // deleted session answered 409 IDEMPOTENCY_KEY_SESSION_DELETED — shown as
    // "connect your account" — and `/new` got the old session back. Racing
    // messages are already serialized by the thread-create claim; a Teams
    // redelivery of the same activity still carries the same key.
    idempotencyKey:
      tenantId && conversationId && activity.id
        ? `teams:create:${tenantId}:${conversationId}:${activity.id}`
        : claimKey,
    postCreate:
      tenantId && conversationId
        ? [{ type: 'bind_chat_thread', platform: 'teams', workspaceId: tenantId, threadId: conversationId }]
        : undefined,
    visibility: teamsSessionIsPersonal(activity) ? 'private' : 'project',
    metadata: {
      source: 'teams',
      teams: {
        tenant_id: tenantId,
        conversation_id: conversationId,
        user: activity.from?.id,
        activity_id: activity.id,
        // Frozen at start: a later `/policy` change applies to NEW sessions only.
        conversation_policy: normalizeConversationPolicy(selection?.conversationPolicy),
        // The team a channel conversation lives in. Each turn gets it as
        // MS_TEAMS_TEAM_GROUP_ID for that turn only; this is the durable
        // record, so a channel session can be traced back to its team (Graph
        // `/teams/{team}/channels/{channel}/…` needs the team id) after the
        // activity is gone. Absent in a personal or group chat: no team.
        ...(activity.channelData?.team?.aadGroupId
          ? {
              team_group_id: activity.channelData.team.aadGroupId,
              ...(activity.channelData.team.name ? { team_name: activity.channelData.team.name } : {}),
            }
          : {}),
      },
    },
    extraEnvVars: buildTeamsTurnEnv(tenantId, activity),
  });

  if (result.error) {
    console.error('[teams-webhook] createProjectSession failed', { status: result.error.status, body: result.error.body });
    // No session exists, so no mapping will ever be published under this
    // claim. Held for its 5-minute TTL, it made every retry inside that
    // window lose the claim, wait 8 s, and fail with "couldn't start" —
    // including the retry the agent picker below asks for.
    if (claimKey) await releaseThreadCreate(claimKey);
    if (handle) {
      // A deleted / renamed / disabled agent is rejected up front as
      // `400 AGENT_NOT_DECLARED`, and no amount of retrying revives it. Hand
      // over the picker instead of a line of text, so one tap re-points the
      // conversation at a live agent.
      const code = (result.error.body as { code?: string } | undefined)?.code;
      if (code === 'AGENT_NOT_DECLARED' && tenantId && conversationId) {
        await finalizeTurn(handle, {
          title: "Couldn't start — pick an agent",
          card: await buildAgentUnavailableCard({
            tenantId,
            conversationId,
            projectId,
            badAgent: selection?.agentName ?? null,
            teamsUserId: teamsUserId(activity),
          }),
        });
      } else {
        await finalizeTurn(handle, { error: startError(result.error.status, result.error.body) });
      }
    }
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

// Teams' binding of the shared channel start-error classifier. It used to map
// only 402 / 429 / 404: every error CODE and every 400, 403, 409 and 5xx
// collapsed into "give it a moment and send your message again", which is the
// wrong instruction for a dead sandbox template or an unlinked account.
function startError(status: number | undefined, body: unknown): string {
  return startErrorMessage(status, body, TEAMS_START_ERROR_COMMANDS);
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

async function releaseThreadCreate(key: string): Promise<void> {
  try {
    await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, key));
  } catch (err) {
    // The claim still expires on its own; only the retry window stays shut.
    console.warn('[teams-webhook] thread-create claim release failed', err);
  }
}

async function waitForConversationSession(
  tenantId: string,
  conversationId: string,
  projectId: string,
): Promise<string | null> {
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
          eq(chatThreads.projectId, projectId),
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
  // The `question` tool renders a real Adaptive Card — one-tap buttons for a
  // single question, a form with a picker per question for several — and it
  // does NOT hang the turn. It used to: the daemons released the blocking call
  // only for SLACK_* env, so a Teams agent that asked a question hung after its
  // card was posted. `POST /turn-question` now releases it from the server for
  // every chat-channel session (channels/question-release.ts), which reaches
  // every sandbox the moment the API deploys — and this prompt ships in that
  // same deploy, so it is never live without its release. Proven on a real dev
  // runtime: the call blocked on `que_…`, the server-style reply returned 200,
  // a second reply returned 404, and the agent resumed with the sentinel.
  '- Need to ask the user something with DISCRETE choices? Use the built-in `question` tool. It renders a real Adaptive Card — one tap per option for a single question, a form with a picker per question for several, a multi-select when you pass `multiple`, and a text box when you pass no options. It returns at once: END your turn, and the answer arrives as a NEW turn with full context.',
  '- Use `teams send` for a question only when it is genuinely open-ended prose with nothing to pick from. A numbered list of choices in a message is the wrong shape — the user cannot tap it.',
  '- Deliver the final answer with `teams send` (text, or an Adaptive Card via --card-file). One `teams send` per turn — it finalizes the live message.',
].join('\n');

const NO_VISION_NOTE = [
  '',
  'IMPORTANT: no image-capable model is available in this project, so you',
  'cannot see the attached image even after downloading it. Do not call `read`',
  'on it and do not look for OCR tools. Tell the user plainly that you cannot',
  'view images here, ask them to paste the text or describe it, and mention',
  'that a project admin can enable an image-capable model.',
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

export function renderFollowUpPrompt(activity: TeamsActivity, imagesUnavailable = false): string {
  const user = activity.from?.name ?? activity.from?.id ?? 'unknown';
  const text = teamsMessageText(activity);
  return [
    `New message from ${user} in the same Teams conversation:`,
    '',
    text,
    ...renderAttachments(activity),
    ...(imagesUnavailable ? [NO_VISION_NOTE] : []),
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(activity: TeamsActivity, revived = false): string {
  const tenant = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? 'unknown';
  const conversation = activity.conversation?.id ?? '?';
  const user = activity.from?.name ?? activity.from?.id ?? 'unknown';
  const text = teamsMessageText(activity);
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
