import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import {
  createProjectSession,
  resolveGitTriggerActor,
} from '../projects';
import { loadTelegramWebhookSecretForProject } from './install-store';
import { makeOpenApiApp, json, errors } from '../openapi';

export const telegramWebhookApp = makeOpenApiApp();

telegramWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}',
    tags: ['channels'],
    summary: 'Telegram bot webhook (secret-token verified)',
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), challenge: z.string().optional() }).passthrough(), 'Accepted'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const expected = await loadTelegramWebhookSecretForProject(projectId);
  if (!expected) return c.json({ error: 'Not configured' }, 404);

  const presented = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  // Constant-time compare (matches Slack/GitHub webhook verification) so the
  // secret can't be recovered via response-timing differences.
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
    return c.json({ error: 'Invalid secret' }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = (await c.req.json()) as TelegramUpdate;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const message = update.message ?? update.edited_message;
  if (!message || !message.chat) return c.json({ ok: true });

  spawnAgentTurn(projectId, update, message).catch((err) =>
    console.error('[telegram-webhook] spawn failed', err),
  );
  return c.json({ ok: true });
},
);

async function spawnAgentTurn(
  projectId: string,
  update: TelegramUpdate,
  message: TelegramMessage,
): Promise<void> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  const userId = await resolveGitTriggerActor(project.accountId);
  if (!userId) {
    console.warn('[telegram-webhook] no actor for project', projectId);
    return;
  }

  const initialPrompt = renderAgentPrompt(update, message);

  const result = await createProjectSession({
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: initialPrompt,
    },
    enforceAccountCap: false,
    // Channel sessions are team-facing — project-visible, not private to the
    // stand-in owner the session is attributed to.
    visibility: 'project',
    metadata: {
      source: 'telegram',
      telegram: {
        chat_id: message.chat.id,
        chat_type: message.chat.type,
        from_id: message.from?.id,
        message_id: message.message_id,
      },
    },
  });

  if (result.error) {
    console.error('[telegram-webhook] createProjectSession failed', result.error.body);
  }
}

function renderAgentPrompt(update: TelegramUpdate, message: TelegramMessage): string {
  const from = message.from?.username
    ? `@${message.from.username}`
    : message.from?.id
      ? String(message.from.id)
      : 'unknown';

  return [
    'You received a message on Telegram.',
    '',
    `Chat:        ${message.chat.id} (${message.chat.type})`,
    `From:        ${from}`,
    `Message id:  ${message.message_id}`,
    '',
    'Message:',
    message.text ?? message.caption ?? '(non-text payload)',
    '',
    'To reply, run:',
    `  telegram send --chat ${message.chat.id} --reply-to ${message.message_id} --text "..."`,
    '',
    'Agent CLIs are installed in /usr/local/bin. Discover them:',
    '  ls /usr/local/bin/            # see every CLI',
    '  <cli> help                    # surface for any specific one',
    '',
    'Common starting points: `telegram help`, `slack help`, `kchannel help`.',
  ].join('\n');
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id?: number; username?: string };
  text?: string;
  caption?: string;
}
