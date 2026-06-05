import { createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { chatInstalls } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackSigningSecretForProject } from '../install-store';
import { slackOauthMode } from '../slack-oauth-mode';
import { json, errors } from '../../openapi';
import { slackWebhookApp } from './app';
import { alreadyHandled } from './dedup';
import { parseEnvelope, verifySlackSignature } from './util';
import {
  dispatchSlackEvent,
  maybePostChannelIntro,
  maybePostPicker,
  resolveOauthProject,
} from './dispatch';
import { publishHomeForUser } from './home';
import { handleBlockAction } from './interactivity';
import { handleSlashCommand } from './commands';
import type { SlackInteractionPayload } from './types';

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

  void dispatchSlackEvent(projectId, envelope).catch((err) =>
    console.error('[slack-webhook] byo handler failed', err),
  );
  return c.json({ ok: true });
},
);
