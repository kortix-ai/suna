import { createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../shared/db';
import {
  createSession,
  resolveWorkspaceAutomationActor,
} from '../workspaces/session-lifecycle';
import { loadTelegramWebhookSecretForWorkspace } from './install-store';
import { makeOpenApiApp, json, errors } from '../openapi';

export const telegramWebhookApp = makeOpenApiApp();

telegramWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}',
    tags: ['channels'],
    summary: 'Telegram bot webhook (secret-token verified)',
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), challenge: z.string().optional() }).passthrough(), 'Accepted'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
  const workspaceId = c.req.param('workspaceId');
  const expected = await loadTelegramWebhookSecretForWorkspace(workspaceId);
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

  spawnAgentTurn(workspaceId, update, message).catch((err) =>
    console.error('[telegram-webhook] spawn failed', err),
  );
  return c.json({ ok: true });
},
);

// Gate for the Telegram equivalent of Slack's SLACK_REQUIRE_USER_IDENTITY: the
// webhook otherwise runs every agent turn AS THE ACCOUNT OWNER for whoever can
// message the bot, with no sender check. Defaults ON: a webhook secret proves
// the request came from Telegram, but not that this sender may run this workspace
// as the automation actor. Operators may temporarily set
// TELEGRAM_REQUIRE_USER_IDENTITY=false only while migrating legacy projects to
// metadata.telegram.allowedUserIds.
// Read live (not module-scope) so it's cheap to flip per-request in tests.
export function telegramRequireUserIdentityForTest(): boolean {
  const raw = (process.env.TELEGRAM_REQUIRE_USER_IDENTITY ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

// "Bound identity" here is a per-Workspace allowlist of Telegram user ids, stored
// in the existing projects.metadata jsonb column (no schema change) at
// metadata.telegram.allowedUserIds. There is no product surface to populate
// this yet — see risk note in the PR. Until one exists, enabling the flag
// rejects every sender for a workspace with no allowlist configured, which is
// the safe direction to fail in.
export function isKnownTelegramSenderForTest(
  workspace: { metadata: unknown },
  message: TelegramMessage,
): boolean {
  const senderId = message.from?.id;
  if (senderId === undefined || senderId === null) return false;
  const metadata = workspace.metadata as
    | { telegram?: { allowedUserIds?: unknown } }
    | null
    | undefined;
  const allowedUserIds = metadata?.telegram?.allowedUserIds;
  if (!Array.isArray(allowedUserIds)) return false;
  return allowedUserIds.some((id) => String(id) === String(senderId));
}

async function spawnAgentTurn(
  workspaceId: string,
  update: TelegramUpdate,
  message: TelegramMessage,
): Promise<void> {
  const [workspace] = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .limit(1);
  if (!workspace) return;

  if (telegramRequireUserIdentityForTest() && !isKnownTelegramSenderForTest(workspace, message)) {
    console.warn(
      '[telegram-webhook] rejecting unbound sender for workspace',
      workspaceId,
      message.from?.id,
    );
    return;
  }

  const userId = await resolveWorkspaceAutomationActor(workspace.accountId);
  if (!userId) {
    console.warn('[telegram-webhook] no actor for workspace', workspaceId);
    return;
  }

  const initialPrompt = renderAgentPrompt(update, message);

  const result = await createSession({
    source: 'telegram',
    workspace,
    userId,
    requestingPrincipalType: 'human',
    body: {
      base_ref: workspace.defaultBranch,
      agent_name: 'default',
      initial_prompt: initialPrompt,
      // Title from the user's actual words, not the scaffolded envelope.
      title_source: message.text ?? message.caption ?? null,
    },
    enforceAccountCap: false,
    queuePolicy: 'on_backpressure',
    idempotencyKey: `telegram:${workspaceId}:${update.update_id}`,
    // Channel sessions are team-facing — workspace-visible, not private to the
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
    console.error('[telegram-webhook] createWorkspaceSession failed', result.error.body);
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
    'Common starting points: `telegram help`, `slack help`.',
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
