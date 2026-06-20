import { createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { chatInstalls } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { generateSlackManifest, resolveBaseUrl } from '../slack-manifest';
import { loadSlackSigningSecretForProject } from '../install-store';
import { slackOauthMode } from '../slack-oauth-mode';
import { json, errors } from '../../openapi';
import { slackWebhookApp } from './app';
import { alreadyHandled } from './dedup';
import { parseEnvelope, verifySlackSignature } from './util';
import {
  dispatchSlackEvent,
  handleAssistantThreadStarted,
  maybeHandleDmCommand,
  maybePostChannelIntro,
  maybePostPicker,
  resolveOauthProject,
} from './dispatch';
import { publishHomeForUser } from './home';
import { handleBlockAction, handleMessageShortcut } from './interactivity';
import { handleSlashCommand } from './commands';
import type { SlackInteractionPayload, SlashResponse } from './types';

// ── Shared slash + interactivity processing ───────────────────────────────────
// The canonical OAuth app and per-project (BYO) apps run the SAME logic — they
// differ ONLY in which signing secret verifies the request. Each route does its
// own signature check, then hands the verified raw body to these.

/** Parse a slash-command form body and run it → the Slack response object. */
async function runSlashCommandBody(rawBody: string): Promise<SlashResponse> {
  const params = new URLSearchParams(rawBody);
  const text = (params.get('text') ?? '').trim();
  const teamId = params.get('team_id') ?? '';
  const channelId = params.get('channel_id') ?? '';
  const command = params.get('command') || '/kortix';
  const responseUrl = params.get('response_url') ?? undefined;

  const [sub, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  const subLower = (sub || 'help').toLowerCase();
  try {
    return await handleSlashCommand(subLower, arg, { teamId, channelId, command, responseUrl });
  } catch (err) {
    console.error('[slack-webhook] slash command failed', err);
    return { response_type: 'ephemeral', text: 'Something went wrong handling that command. Try again in a moment.' };
  }
}

/** Parse an interactivity form body and fire the right handler (best-effort). */
function runInteractivityBody(rawBody: string): void {
  const payloadRaw = new URLSearchParams(rawBody).get('payload');
  if (!payloadRaw) return;
  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadRaw) as SlackInteractionPayload;
  } catch {
    return;
  }
  if (payload.type === 'block_actions') {
    void handleBlockAction(payload).catch((err) =>
      console.error('[slack-webhook] block action failed', err),
    );
  } else if (payload.type === 'message_action') {
    void handleMessageShortcut(payload).catch((err) =>
      console.error('[slack-webhook] message shortcut failed', err),
    );
  }
}

slackWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['channels'],
    summary: 'Slack Events API webhook (signature verified)',
    request: {
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean().optional(), challenge: z.string().optional() }).passthrough(), 'Accepted'),
      ...errors(400, 401, 503),
    },
  }),
  async (c: any) => {
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
  if (await alreadyHandled(envelope.event_id)) return c.json({ ok: true });

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
    // Opening the Kortix DM (AI-Assistant pane) → greet with the project picker.
    // The channel/thread live on event.assistant_thread, NOT the top-level event,
    // so resolveOauthProject can't see it — handle it before that branch.
    if (envelope.event?.type === 'assistant_thread_started') {
      await handleAssistantThreadStarted(teamId, envelope.event);
      return;
    }
    // A `/kortix …` typed in a DM (the Assistant pane can't run real slash
    // commands) arrives as a plain message — run it as the command it is.
    if (envelope.event && (await maybeHandleDmCommand(teamId, envelope.event))) {
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
},
);

slackWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/interactivity',
    tags: ['channels'],
    summary: 'Slack interactivity webhook (signature verified)',
    request: {
      body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }).passthrough(), 'Accepted'),
      ...errors(401, 503),
    },
  }),
  async (c: any) => {
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
  runInteractivityBody(rawBody);
  return c.json({ ok: true });
},
);

// Slash commands — Slack POSTs application/x-www-form-urlencoded here when
// a user runs `/kortix …` in any channel/DM. Must respond within 3s.
slackWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/commands',
    tags: ['channels'],
    summary: 'Slack slash command webhook (signature verified)',
    request: {
      body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ response_type: z.string().optional(), text: z.string().optional() }).passthrough(), 'Slash command response'),
      ...errors(401, 503),
    },
  }),
  async (c: any) => {
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

  return c.json(await runSlashCommandBody(rawBody));
},
);

slackWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}',
    tags: ['channels'],
    summary: 'Per-project (BYO app) Slack Events webhook (signature verified)',
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean().optional(), challenge: z.string().optional() }).passthrough(), 'Accepted'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
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
  if (await alreadyHandled(envelope.event_id)) return c.json({ ok: true });

  void (async () => {
    const teamId = envelope.team_id ?? envelope.event?.team ?? '';
    if (envelope.event && (await maybeHandleDmCommand(teamId, envelope.event, projectId))) {
      return;
    }
    await dispatchSlackEvent(projectId, envelope);
  })().catch((err) => console.error('[slack-webhook] byo handler failed', err));
  return c.json({ ok: true });
},
);

// Per-project (BYO app) slash commands — parity with the canonical /commands,
// verified with the project's OWN signing secret. The BYO manifest points its
// slash command url here.
slackWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/commands',
    tags: ['channels'],
    summary: 'Per-project (BYO app) Slack slash command webhook (signature verified)',
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ response_type: z.string().optional(), text: z.string().optional() }).passthrough(), 'Slash command response'),
      ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const rawBody = await c.req.text();
  const signingSecret = await loadSlackSigningSecretForProject(projectId);
  if (!signingSecret) return c.json({ error: 'Not configured' }, 404);
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  return c.json(await runSlashCommandBody(rawBody));
},
);

// Per-project (BYO app) interactivity — parity with the canonical /interactivity
// (block-action pickers + the "Open in Kortix" message shortcut), verified with
// the project's own signing secret. The BYO manifest points interactivity here.
slackWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/interactivity',
    tags: ['channels'],
    summary: 'Per-project (BYO app) Slack interactivity webhook (signature verified)',
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }).passthrough(), 'Accepted'),
      ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const rawBody = await c.req.text();
  const signingSecret = await loadSlackSigningSecretForProject(projectId);
  if (!signingSecret) return c.json({ error: 'Not configured' }, 404);
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  runInteractivityBody(rawBody);
  return c.json({ ok: true });
},
);

// The per-project (BYO) Slack manifest — served from the SAME builder the
// canonical app uses, so the in-sandbox `kortix-agent slack manifest` command
// fetches this instead of carrying its own copy. No secrets, no DB: it's a
// scaffolding template (the project may not have Slack configured yet), so it's
// intentionally unauthenticated and works for any projectId.
slackWebhookApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/manifest',
    tags: ['channels'],
    summary: 'Per-project (BYO app) Slack app manifest (single source of truth)',
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ name: z.string().optional() }),
    },
    responses: {
      200: json(z.any(), 'Slack app manifest JSON'),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const name = c.req.query('name') || undefined;
  // Prefer the configured public URL; fall back to the request host.
  const baseUrl = resolveBaseUrl(new URL(c.req.url), config.KORTIX_URL || undefined);
  return c.json(generateSlackManifest({ baseUrl, projectId, appName: name, botName: name }));
},
);
