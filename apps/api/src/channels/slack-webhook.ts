import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import {
  createProjectSession,
  resolveGitTriggerActor,
} from '../projects';
import {
  loadSlackBotUserIdForProject,
  loadSlackSigningSecretForProject,
} from './install-store';

export const slackWebhookApp = new Hono();

const FIVE_MINUTES = 5 * 60;

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

  let event: SlackEnvelope;
  try {
    event = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (event.type === 'url_verification') {
    return c.json({ challenge: event.challenge });
  }

  if (event.type !== 'event_callback' || !event.event) {
    return c.json({ ok: true });
  }

  const inner = event.event;
  const botUserId = await loadSlackBotUserIdForProject(projectId);
  if (botUserId && inner.user === botUserId) return c.json({ ok: true });
  if (inner.bot_id) return c.json({ ok: true });

  const shouldTrigger =
    inner.type === 'app_mention' ||
    (inner.type === 'message' && inner.channel_type === 'im') ||
    (inner.type === 'message' && inner.thread_ts && !inner.subtype);
  if (!shouldTrigger) return c.json({ ok: true });

  spawnAgentTurn(projectId, event, inner).catch((err) =>
    console.error('[slack-webhook] spawn failed', err),
  );
  return c.json({ ok: true });
});

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
        team_id: envelope.team_id,
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts ?? event.ts,
        event_type: event.type,
      },
    },
  });

  if (result.error) {
    console.error('[slack-webhook] createProjectSession failed', result.error.body);
  }
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
    'You can also use: slack history, slack thread, slack react, slack edit,',
    'slack delete, slack channel-info, slack users. Run `slack help` for the full list.',
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
}
