/** Slack channel: install, mode, connect, disconnect, file proxy, and thread binding. */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  deleteSlackInstall,
  loadSlackInstall,
  saveSlackInstall,
} from '../../channels/install-store';
import { INSTALL_STATE_INVALID, InstallCompletionBody } from '../../channels/install-completion';
import { buildSlackInstallUrl, completeSlackOauthInstall } from '../../channels/slack-oauth';
import { slackOauthMode } from '../../channels/slack-oauth-mode';
import { bindChatThread, resolveWorkspaceIdForChannel } from '../../channels/slack/binding';
import { downloadSlackFile, uploadSlackFile } from '../../channels/slack/file-proxy';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import { readBody } from '../lib/serializers';

interface SlackAuthTest {
  ok: boolean;
  team_id?: string;
  team?: string;
  user_id?: string;
  error?: string;
}

// ─── Slack install — per project, secrets live in project_secrets ────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const install = await loadSlackInstall(projectId);
    return c.json(install ?? null);
  },
);

// GET /v1/projects/:projectId/channels/slack/mode
// Tells the dashboard whether one-click "Add to Slack" is available (server
// has SLACK_CLIENT_ID + SECRET + SIGNING_SECRET set) and the pre-signed
// install URL to redirect the user to.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/mode',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const mode = slackOauthMode();
    if (!mode.available) {
      return c.json({ oauth_available: false, install_url: null });
    }
    try {
      const installUrl = buildSlackInstallUrl(projectId, loaded.userId);
      return c.json({ oauth_available: true, install_url: installUrl });
    } catch {
      return c.json({ oauth_available: false, install_url: null });
    }
  },
);

// POST /v1/projects/:projectId/channels/slack/oauth/complete
// The web completion page posts the provider's {code, state} here with the
// signed-in user's bearer. The install lands only when the signed state names
// this caller and this project (see channels/install-completion.ts).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/oauth/complete',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/oauth/complete',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: InstallCompletionBody } } },
    },
    responses: {
      200: json(z.object({ redirect_url: z.string() }), 'OK'),
      ...errors(400, 403, 404, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Same gate as the manual connect route: installing a Slack app is a
    // connector-write capability.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const body = InstallCompletionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Missing code or state', code: INSTALL_STATE_INVALID }, 400);
    }
    const result = await completeSlackOauthInstall({
      projectId,
      userId: loaded.userId,
      code: body.data.code,
      state: body.data.state,
    });
    if (!result.ok) {
      return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status);
    }
    return c.json({ redirect_url: result.redirectUrl });
  },
);

// POST /v1/projects/:projectId/channels/slack/connect

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Connecting a Slack workspace is a connector-write capability — a custom
    // role can withhold it and a scoped agent must hold it (central fold).
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );

    let body: { bot_token?: string; signing_secret?: string };
    try {
      body = (await c.req.json()) as {
        bot_token?: string;
        signing_secret?: string;
      };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const botToken = body.bot_token?.trim();
    const signingSecret = body.signing_secret?.trim();
    if (!botToken || !botToken.startsWith('xoxb-')) {
      return c.json({ error: 'bot_token is required and must start with xoxb-' }, 400);
    }
    if (!signingSecret) {
      return c.json({ error: 'signing_secret is required' }, 400);
    }

    let authTest: SlackAuthTest;
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${botToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
      });
      authTest = (await res.json()) as SlackAuthTest;
    } catch (err) {
      return c.json({ error: `Failed to reach Slack: ${(err as Error).message}` }, 502);
    }
    if (!authTest.ok || !authTest.team_id || !authTest.user_id) {
      return c.json(
        {
          error: `Slack rejected the token: ${authTest.error ?? 'unknown error'}`,
        },
        400,
      );
    }

    const summary = await saveSlackInstall({
      projectId,
      botToken,
      signingSecret,
      teamId: authTest.team_id,
      teamName: authTest.team ?? null,
      botUserId: authTest.user_id,
    });
    await reconcileChannelConnectors(projectId);
    return c.json(summary);
  },
);

// DELETE /v1/projects/:projectId/channels/slack/installation

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/slack/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/slack/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Disconnecting Slack tears down the connector — same connector-write gate.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    await deleteSlackInstall(projectId);
    // Tear down the auto-materialized Slack connector now that the install is gone.
    await reconcileChannelConnectors(projectId);
    return c.json({ status: 'disconnected' });
  },
);

// GET /v1/projects/:projectId/channels/slack/file?url=...
// Server-side download proxy: fetch a Slack-hosted file with the bot token
// (SSRF-guarded to *.slack.com) so the sandbox never holds the token. Backs
// `slack download` once the token is out of the box (KORTIX-206 Phase C2).
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/slack/file',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/slack/file (download proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ url: z.string() }),
    },
    responses: {
      200: {
        description: 'File bytes',
        content: { 'application/octet-stream': { schema: z.any() } },
      },
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const result = await downloadSlackFile(projectId, c.req.query('url') ?? '');
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    c.header('Content-Type', result.contentType);
    return c.body(result.body);
  },
);

// POST /v1/projects/:projectId/channels/slack/file/upload
// Server-side upload proxy: the 3-step external upload, bot token server-side.
// Backs `slack send --file` once the token is out of the box.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/file/upload',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/file/upload (upload proxy)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), files: z.any() }).passthrough(), 'Uploaded'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // This is a SEND primitive (posts to Slack with the project's bot token), not
    // a read — a bare project-read gate let ANY project-read caller post
    // arbitrary files to the workspace. The channel.send leaf in iam/actions.ts
    // is cataloged but scoped to resource_type='channel' and was never wired
    // through assertProjectCapability's project-scoped fold (nothing asserts it
    // today — see the audit note removing CHANNEL_ACTIONS). Reuse the connector
    // capability that already gates connect/disconnect and the channel-bindings
    // route instead of inventing a parallel gate for the same resource.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const body = await readBody(c);
    const result = await uploadSlackFile(projectId, {
      channel: String(body.channel ?? ''),
      filename: String(body.filename ?? ''),
      contentBase64: String(body.content_base64 ?? body.contentBase64 ?? ''),
      comment: typeof body.comment === 'string' ? body.comment : undefined,
      threadTs:
        typeof body.thread_ts === 'string'
          ? body.thread_ts
          : typeof body.threadTs === 'string'
            ? body.threadTs
            : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return c.json({ ok: true, files: result.files });
  },
);

// POST /v1/projects/:projectId/channels/slack/bind-thread
// Bind a Slack thread the agent created (e.g. from a webhook/cron run) to its
// session, so a later human reply in that thread routes back into this session
// (approval loops, follow-up Q&A). This writes the same `chat_threads` row the
// inbound `bind_chat_thread` post-create action does; without it, replies to a
// non-Slack-originated thread are classified `ignore` and dropped.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/slack/bind-thread',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/slack/bind-thread',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), bound: z.boolean() }).passthrough(), 'Bound'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Same dual auth as turn-stream: the in-sandbox agent's sandbox token (scoped
    // back to this project) or a project/session-scoped user PAT.
    // The session this credential is BOUND to, when it is a sandbox token.
    let callerSandboxSessionId: string | null = null;
    if (isSessionSandboxCredential(c)) {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'bind-thread requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
      callerSandboxSessionId = sandbox.sessionId ?? sandbox.sandboxId;
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Binding a Slack thread creates channel→session routing (inbound Slack
      // messages drive this session) — a connector-write action, matching the
      // Slack connect/disconnect/file-upload twins. Threads the acting token so
      // a custom role that withholds connector.write, or a scoped agent lacking
      // it, is denied. The sandbox-token branch above is already project-scoped.
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
      );
    }

    let body: {
      session_id?: string;
      channel?: string;
      thread_ts?: string;
      workspace_id?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const sessionId = body.session_id?.trim();
    const channel = body.channel?.trim();
    const threadTs = body.thread_ts?.trim();
    if (!sessionId || !channel || !threadTs) {
      return c.json({ error: 'session_id, channel, and thread_ts are required' }, 400);
    }
    // A sandbox token acts for exactly ONE session. Binding a thread routes
    // later Slack replies in it into `session_id`, so it may name only the
    // token's own session, never a sibling in the same project.
    if (
      callerSandboxSessionId !== null &&
      !sandboxTokenMayActOnSession(callerSandboxSessionId, sessionId)
    ) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }
    // the session must belong to this project
    const [sess] = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!sess) {
      return c.json({ error: 'session not found in project' }, 404);
    }
    const workspaceId =
      body.workspace_id?.trim() || (await resolveWorkspaceIdForChannel(projectId, channel));
    if (!workspaceId) {
      return c.json(
        {
          error:
            'could not resolve Slack workspace for channel (is the channel bound to this project?)',
        },
        400,
      );
    }
    await bindChatThread({ projectId, workspaceId, threadId: threadTs, sessionId });
    return c.json({ ok: true, bound: true, channel, thread_ts: threadTs });
  },
);
