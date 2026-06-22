import { and, eq } from 'drizzle-orm';
import { chatEventDedup, chatThreads, projects } from '@kortix/db';
import { db } from '../../shared/db';
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { buildTeamsTurnEnv, finalizeTurn, persistServiceUrl, saveTurn, startTurn } from './turn';
import type { TeamsActivity } from './types';

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

export async function deliverTeamsFollowUpToSession(input: {
  sessionId: string;
  text: string;
  userId?: string | null;
}) {
  return teamsSessionLifecycle.continueSession({
    source: 'teams',
    sessionId: input.sessionId,
    text: input.text,
    userId: input.userId,
  });
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

  await persistServiceUrl(projectId, activity.serviceUrl);

  const userId = await teamsSessionLifecycle.resolveProjectAutomationActor(project.accountId);
  if (!userId) {
    console.warn('[teams-webhook] no actor for project', projectId);
    return;
  }

  const claimKey = tenantId && conversationId ? `teams:threadcreate:${tenantId}:${conversationId}` : null;
  if (claimKey && !(await claimThreadCreate(claimKey))) {
    const sessionId = await waitForConversationSession(tenantId, conversationId);
    if (sessionId) {
      await deliverTeamsFollowUpToSession({ sessionId, text: renderFollowUpPrompt(activity) });
    } else {
      console.warn('[teams-webhook] lost thread-create claim but winner never published a session', {
        tenantId,
        conversationId,
      });
    }
    return;
  }

  if (tenantId && conversationId) {
    const [existing] = await db
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
    if (existing) {
      await deliverTeamsFollowUpToSession({ sessionId: existing.sessionId, text: renderFollowUpPrompt(activity) });
      return;
    }
  }

  const handle = await startTurn(projectId, tenantId, activity);

  const result = await teamsSessionLifecycle.createSession({
    source: 'teams',
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: renderAgentPrompt(activity),
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

  if (result.sessionId && handle) {
    handle.sessionId = result.sessionId;
    await saveTurn(handle);
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
  '- The `teams` CLI needs no token in your sandbox — every command runs through the Kortix Executor (the bot credential is resolved server-side).',
  '- As you go, post a short progress checkpoint before each major step:',
  '    teams step "Reading the incident logs"',
  '  Keep them human and brief — a few per task — and post one right before anything slow so the conversation always shows fresh progress.',
  '- Attach inline context with `--detail`, and surface a finished step result with `--output`:',
  '    teams step "Drafting summary" --output "Found 3 incidents, 1 P0"',
  '- Need to ask the user something? Use `teams send`, then END your turn — Teams questions are async: ask, stop, and resume when they reply.',
  '- Deliver the final answer with `teams send` (text, or an Adaptive Card via --card-file). One `teams send` per turn — it finalizes the live message.',
].join('\n');

export function renderFollowUpPrompt(activity: TeamsActivity): string {
  const user = activity.from?.name ?? activity.from?.id ?? 'unknown';
  const text = activity.text ?? '';
  return [`New message from ${user} in the same Teams conversation:`, '', text, '', TURN_INSTRUCTIONS].join('\n');
}

function renderAgentPrompt(activity: TeamsActivity): string {
  const tenant = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? 'unknown';
  const conversation = activity.conversation?.id ?? '?';
  const user = activity.from?.name ?? activity.from?.id ?? 'unknown';
  const text = activity.text ?? '';
  return [
    "You're answering a message on Microsoft Teams as a teammate.",
    '',
    `Tenant:        ${tenant}`,
    `Conversation:  ${conversation}`,
    `User:          ${user}`,
    '',
    'Message:',
    text,
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}
