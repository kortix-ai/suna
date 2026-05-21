import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { chatChannelBindings, chatThreads, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getDaytona } from '../shared/daytona';
import {
  createProjectSession,
  resolveGitTriggerActor,
} from '../projects';
import {
  loadSlackBotUserIdForProject,
  loadSlackSigningSecretForProject,
} from './install-store';
import { slackOauthMode } from './slack-oauth-mode';

export const slackWebhookApp = new Hono();

const FIVE_MINUTES = 5 * 60;

// OAuth mode — single endpoint, shared signing secret, route by team_id.
// Reached when the Kortix Slack App posts events here. Returns 503 if the
// server isn't configured for OAuth (BYO mode users hit /:projectId instead).
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

  const teamId = envelope.team_id ?? envelope.event.team ?? '';
  if (!teamId) return c.json({ ok: true });

  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, teamId),
      ),
    )
    .limit(1);
  if (!binding) return c.json({ ok: true });

  await dispatchSlackEvent(binding.projectId, envelope);
  return c.json({ ok: true });
});

// BYO mode — per-project URL, per-project signing secret. The "bring your own
// Slack app" path for users who can't / won't install the shared Kortix Slack
// App. No bindings table lookup needed; project is in the URL.
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

  await dispatchSlackEvent(projectId, envelope);
  return c.json({ ok: true });
});

async function dispatchSlackEvent(projectId: string, envelope: SlackEnvelope): Promise<void> {
  const event = envelope.event;
  if (!event) return;

  const botUserId = await loadSlackBotUserIdForProject(projectId);
  if (botUserId && event.user === botUserId) return;
  if (event.bot_id) return;

  const shouldTrigger =
    event.type === 'app_mention' ||
    (event.type === 'message' && event.channel_type === 'im') ||
    (event.type === 'message' && event.thread_ts && !event.subtype);
  if (!shouldTrigger) return;

  spawnAgentTurn(projectId, envelope, event).catch((err) =>
    console.error('[slack-webhook] spawn failed', err),
  );
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
  console.log('[slack-webhook] dispatch', {
    projectId,
    teamId,
    threadId,
    eventType: event.type,
    eventTs: event.ts,
    eventThreadTs: event.thread_ts,
    user: event.user,
  });

  // Thread continuity: if a session already owns this thread, deliver the
  // new message as a follow-up to that running sandbox instead of spawning
  // a fresh session with no conversation history.
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
    console.log('[slack-webhook] thread lookup', {
      threadId,
      found: !!existing,
      existingSessionId: existing?.sessionId ?? null,
    });
    if (existing) {
      const outcome = await deliverFollowUpToSandbox(existing.sessionId, envelope, event);
      console.log('[slack-webhook] follow-up outcome', { sessionId: existing.sessionId, outcome });
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
      if (outcome === 'transient') {
        // The sandbox is alive but the relay failed for a transient reason —
        // /kortix/prompt 409 (opencode still pinning), network blip, opencode
        // mid-restart. Don't spawn a duplicate session. The user can retry
        // by sending another message and we'll attempt delivery again.
        console.warn('[slack-webhook] follow-up delivery transient failure — skipping');
        return;
      }
      // outcome === 'stale': the original sandbox is gone (stopped, archived,
      // evicted). Drop the row and fall through to spawning a fresh session.
      console.info('[slack-webhook] thread session is stale, replacing');
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

  const initialPrompt = renderAgentPrompt(envelope, event);

  const result = await createProjectSession({
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: initialPrompt,
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
    return;
  }

  // Remember the session ↔ thread mapping for follow-ups.
  console.log('[slack-webhook] post-spawn chat_threads insert check', {
    hasRow: !!result.row,
    sessionId: result.row?.sessionId ?? null,
    teamId,
    threadId,
  });
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
      console.log('[slack-webhook] chat_threads row written', {
        sessionId: result.row.sessionId,
        threadId,
      });
    } catch (err) {
      console.warn('[slack-webhook] failed to record chat_threads row', err);
    }
  } else {
    console.warn('[slack-webhook] SKIPPED chat_threads insert', {
      reason: !result.row ? 'no result.row' : !teamId ? 'no teamId' : !threadId ? 'no threadId' : 'unknown',
    });
  }
}

/**
 * Deliver a follow-up Slack message to the kortix-agent's /kortix/prompt
 * endpoint, which forwards it to the pinned opencode session. Returns true
 * on delivery, false if the sandbox is gone or unreachable (caller can fall
 * back to spawning a fresh session).
 */
type DeliveryOutcome = 'delivered' | 'transient' | 'stale';

/**
 * Try to deliver a follow-up Slack message to the kortix-agent's
 * /kortix/prompt endpoint inside the running sandbox.
 *
 * Returns:
 *   'delivered' — opencode accepted the prompt
 *   'transient' — sandbox is alive but the relay failed for a reason that
 *                 will probably succeed on retry (boot race, network blip).
 *                 Caller should NOT spawn a new session — that creates a
 *                 duplicate for the same Slack thread.
 *   'stale'     — sandbox is genuinely gone (stopped, archived, evicted).
 *                 Caller should drop the chat_threads row and spawn fresh.
 */
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

  // No row, or sandbox is stopped/archived/error → genuinely stale.
  if (!sandbox) return 'stale';
  if (sandbox.status === 'stopped' || sandbox.status === 'archived' || sandbox.status === 'error') {
    return 'stale';
  }
  // Still provisioning — alive, just not ready yet.
  if (sandbox.status !== 'active') return 'transient';

  const daytonaSandboxId = (sandbox.metadata as Record<string, unknown> | null)?.[
    'daytonaSandboxId'
  ];
  if (typeof daytonaSandboxId !== 'string' || !daytonaSandboxId) return 'stale';

  // Daytona's public proxy URL needs an X-Daytona-Preview-Token header to
  // route the request to the sandbox's port 8000. Without it the proxy
  // returns 404 "Not found." (which is what bit us before — the same path
  // worked fine when curl'd from inside the sandbox but failed end-to-end).
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

  const followUpText = renderFollowUpPrompt(envelope, event);
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
      body: JSON.stringify({ text: followUpText }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return 'delivered';
    const bodyText = (await res.text()).slice(0, 300);
    console.warn('[slack-webhook] kortix/prompt returned non-ok', {
      status: res.status,
      body: bodyText,
    });
    // 404 = the sandbox image lacks the /kortix/prompt route (predates this
    // feature) → effectively unusable for follow-ups, treat as stale.
    // 5xx + 409 ("no opencode session pinned yet") = transient, retry.
    if (res.status === 404) return 'stale';
    return 'transient';
  } catch (err) {
    console.warn('[slack-webhook] kortix/prompt fetch failed', err);
    return 'transient';
  }
}

/** Short prompt for thread continuations — opencode already has the full
 *  conversation context from the original message, no need to re-explain
 *  the CLIs or workspace. Just the new message + reply hint. */
function renderFollowUpPrompt(envelope: SlackEnvelope, event: SlackEvent): string {
  const channel = event.channel ?? '?';
  const threadTs = event.thread_ts ?? event.ts ?? '';
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';
  return [
    `New message from ${user} in the same Slack thread:`,
    '',
    text,
    '',
    `Reply via: slack send --channel ${channel} --thread ${threadTs} --text "..."`,
  ].join('\n');
}

function renderAgentPrompt(envelope: SlackEnvelope, event: SlackEvent): string {
  const channel = event.channel ?? '?';
  const threadTs = event.thread_ts ?? event.ts ?? '';
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';

  return [
    'You received a message on Slack.',
    '',
    `Workspace:  ${envelope.team_id ?? 'unknown'}`,
    `Channel:    ${channel}`,
    `User:       ${user}`,
    threadTs ? `Thread ts:  ${threadTs}` : '',
    '',
    'Message:',
    text,
    '',
    'To reply in the same thread, run:',
    `  slack send --channel ${channel} --thread ${threadTs} --text "..."`,
    '',
    'Agent CLIs are installed in /usr/local/bin. Discover them:',
    '  ls /usr/local/bin/            # see every CLI',
    '  <cli> help                    # surface for any specific one',
    '',
    'Common starting points: `slack help`, `telegram help`, `kchannel help`.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

interface SlackEnvelope {
  type: string;
  team_id?: string;
  challenge?: string;
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
