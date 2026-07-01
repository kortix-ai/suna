import { createRoute, z } from '@hono/zod-openapi';
import { chatInstalls } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import type { Context } from 'hono';
import { config } from '../../config';
import { errors, json } from '../../openapi';
import { db } from '../../shared/db';
import {
  ChannelDependencyError,
  dependency,
  emptyResponse,
  failJson,
  fireAndLog,
  jsonResponse,
  parseRawBody,
  runChannelWorkflow,
} from '../effect-workflows';
import { loadSlackSigningSecretForProject } from '../install-store';
import { generateSlackManifest, resolveBaseUrl } from '../slack-manifest';
import { slackOauthMode } from '../slack-oauth-mode';
import { slackWebhookApp } from './app';
import { handleSlashCommand } from './commands';
import { alreadyHandled } from './dedup';
import {
  dispatchSlackEvent,
  ensureProjectChannelBinding,
  handleAssistantThreadStarted,
  maybeHandleDmCommand,
  maybePostChannelIntro,
  maybePostPicker,
  resolveOauthProject,
} from './dispatch';
import { publishHomeForUser } from './home';
import { handleBlockAction, handleMessageShortcut } from './interactivity';
import type { SlackEnvelope, SlackInteractionPayload, SlashResponse } from './types';
import { parseEnvelope, verifySlackSignature } from './util';

// ── Shared slash + interactivity processing ───────────────────────────────────
// The canonical OAuth app and per-project (BYO) apps run the SAME logic — they
// differ ONLY in which signing secret verifies the request. Each route does its
// own signature check, then hands the verified raw body to these.

const genericSlashError = (): SlashResponse => ({
  response_type: 'ephemeral',
  text: 'Something went wrong handling that command. Try again in a moment.',
});

const errorCause = (error: unknown) =>
  error instanceof ChannelDependencyError ? error.cause : error;

const verifySlackRequest = (rawBody: string, c: Context, signingSecret: string) =>
  Effect.sync(() =>
    verifySlackSignature(
      rawBody,
      c.req.header('x-slack-request-timestamp') ?? '',
      c.req.header('x-slack-signature') ?? '',
      signingSecret,
    ),
  ).pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : failJson({ error: 'Invalid signature' }, 401))),
  );

const parseSlackEnvelope = (rawBody: string) =>
  Effect.sync(() => parseEnvelope(rawBody)).pipe(
    Effect.flatMap((envelope) =>
      envelope ? Effect.succeed(envelope) : failJson({ error: 'Invalid JSON' }, 400),
    ),
  );

/** Parse a slash-command form body and run it → the Slack response object. */
function slashCommandBodyWorkflow(rawBody: string, projectScopedProjectId?: string) {
  const params = new URLSearchParams(rawBody);
  const text = (params.get('text') ?? '').trim();
  const teamId = params.get('team_id') ?? '';
  const channelId = params.get('channel_id') ?? '';
  const slackUserId = params.get('user_id') ?? '';
  const command = params.get('command') || '/kortix';
  const responseUrl = params.get('response_url') ?? undefined;

  const [sub, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  const subLower = (sub || 'help').toLowerCase();

  return Effect.gen(function* () {
    if (projectScopedProjectId && teamId && channelId) {
      yield* dependency(() =>
        ensureProjectChannelBinding(projectScopedProjectId, teamId, channelId),
      );
    }

    return yield* dependency(() =>
      handleSlashCommand(subLower, arg, {
        teamId,
        channelId,
        slackUserId,
        command,
        responseUrl,
        projectScopedProjectId,
      }),
    ).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error('[slack-webhook] slash command failed', errorCause(error));
          return genericSlashError();
        }),
      ),
    );
  });
}

/** Parse an interactivity form body and fire the right handler (best-effort). */
const interactivityBodyWorkflow = (rawBody: string) =>
  Effect.sync(() => {
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
  });

const oauthEventWorkflow = (envelope: SlackEnvelope) =>
  Effect.gen(function* () {
    const event = envelope.event;
    if (!event) return;
    const teamId = envelope.team_id ?? event.team ?? '';
    if (!teamId) return;
    if (event.type === 'member_joined_channel') {
      yield* dependency(() => maybePostChannelIntro(teamId, event));
      return;
    }
    if (event.type === 'app_home_opened' && event.tab === 'home' && event.user) {
      const user = event.user;
      yield* dependency(() => publishHomeForUser(teamId, user));
      return;
    }
    // Opening the Kortix DM (AI-Assistant pane) → greet with the project picker.
    // The channel/thread live on event.assistant_thread, NOT the top-level event,
    // so resolveOauthProject can't see it — handle it before that branch.
    if (event.type === 'assistant_thread_started') {
      yield* dependency(() => handleAssistantThreadStarted(teamId, event));
      return;
    }
    // A `/kortix …` typed in a DM (the Assistant pane can't run real slash
    // commands) arrives as a plain message — run it as the command it is.
    const handledDmCommand = yield* dependency(() => maybeHandleDmCommand(teamId, event));
    if (handledDmCommand) return;

    const resolution = yield* dependency(() => resolveOauthProject(teamId, event.channel));
    if (resolution.kind === 'project') {
      yield* dependency(() => dispatchSlackEvent(resolution.projectId, envelope));
    } else if (resolution.kind === 'ambiguous') {
      yield* dependency(() => maybePostPicker(teamId, resolution.projectIds, envelope));
    } else if (resolution.kind === 'pending') {
      const installs = yield* dependency(() =>
        db
          .select({ projectId: chatInstalls.projectId })
          .from(chatInstalls)
          .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId))),
      );
      if (installs.length > 0) {
        yield* dependency(() =>
          maybePostPicker(
            teamId,
            installs.map((i) => i.projectId),
            envelope,
          ),
        );
      }
    }
  });

const byoEventWorkflow = (projectId: string, envelope: SlackEnvelope) =>
  Effect.gen(function* () {
    const event = envelope.event;
    if (!event) return;
    const teamId = envelope.team_id ?? event.team ?? '';
    const handledDmCommand = yield* dependency(() =>
      maybeHandleDmCommand(teamId, event, projectId),
    );
    if (handledDmCommand) return;
    yield* dependency(() => dispatchSlackEvent(projectId, envelope));
  });

const oauthEventsRouteWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const mode = slackOauthMode();
    if (!mode.available || !mode.signingSecret) {
      return yield* failJson({ error: 'OAuth mode not configured' }, 503);
    }

    const rawBody = yield* parseRawBody(c);
    yield* verifySlackRequest(rawBody, c, mode.signingSecret);

    const envelope = yield* parseSlackEnvelope(rawBody);
    if (envelope.type === 'url_verification')
      return jsonResponse({ challenge: envelope.challenge });
    if (envelope.type !== 'event_callback' || !envelope.event) return jsonResponse({ ok: true });

    const handled = yield* dependency(() => alreadyHandled(envelope.event_id));
    if (handled) return jsonResponse({ ok: true });

    fireAndLog('[slack-webhook] oauth handler failed', oauthEventWorkflow(envelope));
    return jsonResponse({ ok: true });
  });

const oauthInteractivityRouteWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const mode = slackOauthMode();
    if (!mode.available || !mode.signingSecret) {
      return yield* failJson({ error: 'OAuth mode not configured' }, 503);
    }
    const rawBody = yield* parseRawBody(c);
    yield* verifySlackRequest(rawBody, c, mode.signingSecret);
    yield* interactivityBodyWorkflow(rawBody);
    return jsonResponse({ ok: true });
  });

const oauthCommandsRouteWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const mode = slackOauthMode();
    if (!mode.available || !mode.signingSecret) {
      return jsonResponse(
        { response_type: 'ephemeral', text: 'OAuth mode not configured on this server.' },
        503,
      );
    }
    const rawBody = yield* parseRawBody(c);
    yield* verifySlackRequest(rawBody, c, mode.signingSecret);
    const response = yield* slashCommandBodyWorkflow(rawBody);
    return jsonResponse(response);
  });

const byoEventsRouteWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const projectId = c.req.param('projectId') ?? '';
    const rawBody = yield* parseRawBody(c);
    const envelope = yield* parseSlackEnvelope(rawBody);

    // Slack verifies the Events API request URL before a manual/BYO app can be
    // installed and saved back to Kortix, so there is no project signing secret
    // yet. Only the bootstrap challenge is allowed through this unsigned path;
    // every real callback below remains project-secret verified.
    if (envelope.type === 'url_verification')
      return jsonResponse({ challenge: envelope.challenge });

    const signingSecret = yield* dependency(() => loadSlackSigningSecretForProject(projectId));
    if (!signingSecret) return yield* failJson({ error: 'Not configured' }, 404);

    yield* verifySlackRequest(rawBody, c, signingSecret);

    if (envelope.type !== 'event_callback' || !envelope.event) return jsonResponse({ ok: true });
    const handled = yield* dependency(() => alreadyHandled(envelope.event_id));
    if (handled) return jsonResponse({ ok: true });

    fireAndLog('[slack-webhook] byo handler failed', byoEventWorkflow(projectId, envelope));
    return jsonResponse({ ok: true });
  });

const byoCommandsRouteWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const projectId = c.req.param('projectId') ?? '';
    const rawBody = yield* parseRawBody(c);
    const signingSecret = yield* dependency(() => loadSlackSigningSecretForProject(projectId));
    if (!signingSecret) return yield* failJson({ error: 'Not configured' }, 404);
    yield* verifySlackRequest(rawBody, c, signingSecret);
    const response = yield* slashCommandBodyWorkflow(rawBody, projectId);
    return jsonResponse(response);
  });

const byoInteractivityRouteWorkflow = (c: Context) =>
  Effect.gen(function* () {
    const projectId = c.req.param('projectId') ?? '';
    const rawBody = yield* parseRawBody(c);
    const signingSecret = yield* dependency(() => loadSlackSigningSecretForProject(projectId));
    if (!signingSecret) return yield* failJson({ error: 'Not configured' }, 404);
    yield* verifySlackRequest(rawBody, c, signingSecret);
    yield* interactivityBodyWorkflow(rawBody);
    return emptyResponse();
  });

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
      200: json(
        z.object({ ok: z.boolean().optional(), challenge: z.string().optional() }).passthrough(),
        'Accepted',
      ),
      ...errors(400, 401, 503),
    },
  }),
  async (c: Context) => {
    return runChannelWorkflow(c, oauthEventsRouteWorkflow(c));
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
  async (c: Context) => {
    return runChannelWorkflow(c, oauthInteractivityRouteWorkflow(c));
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
      200: json(
        z
          .object({ response_type: z.string().optional(), text: z.string().optional() })
          .passthrough(),
        'Slash command response',
      ),
      ...errors(401, 503),
    },
  }),
  async (c: Context) => {
    return runChannelWorkflow(c, oauthCommandsRouteWorkflow(c));
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
      200: json(
        z.object({ ok: z.boolean().optional(), challenge: z.string().optional() }).passthrough(),
        'Accepted',
      ),
      ...errors(400, 401, 404),
    },
  }),
  async (c: Context) => {
    return runChannelWorkflow(c, byoEventsRouteWorkflow(c));
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
      200: json(
        z
          .object({ response_type: z.string().optional(), text: z.string().optional() })
          .passthrough(),
        'Slash command response',
      ),
      ...errors(401, 404),
    },
  }),
  async (c: Context) => {
    return runChannelWorkflow(c, byoCommandsRouteWorkflow(c));
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
  async (c: Context) => {
    return runChannelWorkflow(c, byoInteractivityRouteWorkflow(c));
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
      query: z.object({ name: z.string().optional(), command: z.string().optional() }),
    },
    responses: {
      200: json(z.any(), 'Slack app manifest JSON'),
    },
  }),
  async (c: Context) => {
    const projectId = c.req.param('projectId') ?? '';
    const name = c.req.query('name') || undefined;
    const command = c.req.query('command') || undefined;
    // Prefer the configured public URL; fall back to the request host.
    const baseUrl = resolveBaseUrl(new URL(c.req.url), config.KORTIX_URL || undefined);
    return c.json(
      generateSlackManifest({ baseUrl, projectId, appName: name, botName: name, command }),
    );
  },
);
