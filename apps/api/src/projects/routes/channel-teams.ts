/** Microsoft Teams channel: install, mode, manifest, connect, disconnect, files, and posting. */
import { createRoute, z } from '@hono/zod-openapi';
import {
  deleteTeamsInstall,
  loadTeamsAppIdForProject,
  loadTeamsInstall,
  saveTeamsInstall,
} from '../../channels/install-store';
import { resolveBaseUrl } from '../../channels/slack-manifest';
import { proveTeamsTenant, teamsChannelEnabled } from '../../channels/teams-auth';
import { buildTeamsManifest } from '../../channels/teams-manifest';
import { teamsDeepLink, teamsMode } from '../../channels/teams-mode';
import { teamsOrgConsentUrl } from '../../channels/teams-oauth';
import { downloadTeamsFile, initiateTeamsUpload } from '../../channels/teams/file-proxy';
import { listTeamsPostTargets, postToTeamsConversation } from '../../channels/teams/post';
import { config } from '../../config';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { featureDisabledBody } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { readBody } from '../lib/serializers';

function teamsPublicBaseUrl(): string | undefined {
  return config.KORTIX_URL?.startsWith('https://') ? config.KORTIX_URL : undefined;
}

// ─── Microsoft Teams install — shared multi-tenant app, bind a tenant ────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/installation',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const install = await loadTeamsInstall(projectId);
    return c.json(install ?? null);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/mode',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const baseUrl = resolveBaseUrl(new URL(c.req.url), teamsPublicBaseUrl());
    const byoAppId = await loadTeamsAppIdForProject(projectId);
    const install = await loadTeamsInstall(projectId).catch(() => null);
    const enabled = teamsChannelEnabled(loaded.row.metadata);
    return c.json({
      ...teamsMode(baseUrl, { enabled, projectId, byoAppId }),
      orgConsentUrl: byoAppId ? null : teamsOrgConsentUrl({ projectId, baseUrl, enabled }),
      orgInstalled: install?.orgInstalled ?? false,
      deepLinkUrl: install?.catalogAppId ? teamsDeepLink(install.catalogAppId) : null,
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/manifest',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/manifest',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const byoAppId = await loadTeamsAppIdForProject(projectId);
    const baseUrl = resolveBaseUrl(new URL(c.req.url), teamsPublicBaseUrl());
    const mode = teamsMode(baseUrl, {
      enabled: teamsChannelEnabled(loaded.row.metadata),
      projectId,
      byoAppId,
    });
    if (!mode.available || !mode.appId) {
      return c.json({ error: 'Teams is not configured on this server' }, 409);
    }
    return c.json(
      buildTeamsManifest({
        appId: mode.appId,
        baseUrl,
        appName: config.TEAMS_APP_NAME,
        botName: config.TEAMS_APP_NAME,
      }),
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/teams/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/teams/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Connecting a Teams bot is a connector-write capability — a custom role can
    // withhold it and a scoped agent must hold it (central fold), mirroring the
    // Slack (r4 slack/connect) and email connect twins.
    // Authz before the feature-flag check so an unauthorized caller never gets a
    // capability-independent answer (same order as the file-upload twin below).
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!teamsChannelEnabled(loaded.row.metadata)) {
      return c.json(featureDisabledBody('teams'), 403);
    }

    let body: { tenant_id?: string; team_name?: string; app_id?: string; app_password?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const tenantId = body.tenant_id?.trim();
    const isGuid = (v: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const isDomain = (v: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
    if (!tenantId || (!isGuid(tenantId) && !isDomain(tenantId))) {
      return c.json(
        { error: 'tenant_id is required and must be an Azure AD tenant GUID or domain' },
        400,
      );
    }

    const appId = body.app_id?.trim() || null;
    const appPassword = body.app_password?.trim() || null;
    if ((appId && !appPassword) || (!appId && appPassword)) {
      return c.json(
        { error: 'app_id and app_password must be provided together for a bring-your-own bot' },
        400,
      );
    }
    if (appId && !isGuid(appId)) {
      return c.json({ error: 'app_id must be an Azure AD application (client) GUID' }, 400);
    }

    // A tenant id or domain is public, so typing one proves nothing. The
    // install decides which tenant's messages route to this project and which
    // tenant the file proxy mints Graph tokens for, so it is accepted only
    // with proof of the tenant:
    //  - a bring-your-own bot proves it with its own credentials (Microsoft
    //    issues the app a token for that tenant only when the app is there);
    //  - the managed bot proves it through "Connect with Microsoft" (the OAuth
    //    callback reads the tenant from Microsoft's token), not through here.
    if (!appId || !appPassword) {
      return c.json(
        {
          error:
            'A tenant id alone cannot be verified. Use "Connect with Microsoft" to connect the Kortix bot, ' +
            'or connect your own bot with its app id and client secret.',
          code: 'TEAMS_TENANT_UNVERIFIED',
        },
        400,
      );
    }
    const proof = await proveTeamsTenant({ tenantId, creds: { appId, appPassword } });
    if (!proof.ok) {
      return c.json({ error: proof.error, code: 'TEAMS_TENANT_UNVERIFIED' }, 400);
    }

    const summary = await saveTeamsInstall({
      projectId,
      tenantId: proof.tenantId,
      teamName: body.team_name?.trim() || null,
      appId,
      appPassword,
    });
    void reconcileChannelConnectors(projectId);
    return c.json(summary);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/teams/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/teams/installation',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'OK'), ...errors(404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Disconnecting the Teams bot is connector-write — twin of the Slack/email
    // disconnect gates; a custom role can withhold it, a scoped agent must hold it.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    await deleteTeamsInstall(projectId);
    void reconcileChannelConnectors(projectId);
    return c.json({ status: 'disconnected' });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/file',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/file (download proxy)',
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
    const result = await downloadTeamsFile(projectId, c.req.query('url') ?? '');
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    c.header('Content-Type', result.contentType);
    return c.body(result.body);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/teams/conversations',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/teams/conversations (proactive-post targets)',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(
        z.object({ conversations: z.array(z.object({ conversationId: z.string(), name: z.string().nullable(), type: z.string().nullable() })) }),
        'Conversations this project may post into',
      ),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!teamsChannelEnabled(loaded.row.metadata)) return c.json(featureDisabledBody('teams'), 403);
    return c.json({ conversations: await listTeamsPostTargets(projectId) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/teams/message',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/teams/message (proactive post)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), conversationId: z.string(), delivered: z.string() }).passthrough(),
        'Message posted',
      ),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Posting into a customer's Teams conversation is a send primitive, gated
    // on connector-write exactly like the file upload below.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!teamsChannelEnabled(loaded.row.metadata)) return c.json(featureDisabledBody('teams'), 403);
    const body = await readBody(c);
    const result = await postToTeamsConversation(projectId, {
      conversationId: String(body.conversation_id ?? body.conversationId ?? ''),
      text: typeof body.text === 'string' ? body.text : undefined,
      card: body.card && typeof body.card === 'object' && !Array.isArray(body.card) ? (body.card as Record<string, unknown>) : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404);
    return c.json(result);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/teams/file/upload',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/teams/file/upload (consent-card upload)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(
        z
          .object({ ok: z.boolean(), delivered: z.string(), uploadId: z.string().optional(), url: z.string().optional() })
          .passthrough(),
        'File delivered (consent card, inline image, or team-drive link)',
      ),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Posting a consent card drives the project bot to SEND into the customer's
    // Teams channel — a send primitive gated on connector-write like the Slack
    // (r4 slack/file/upload) and meet/speak twins. Authz before the feature-flag
    // check so an unauthorized caller never gets a capability-independent answer.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!teamsChannelEnabled(loaded.row.metadata)) {
      return c.json(featureDisabledBody('teams'), 403);
    }
    const body = await readBody(c);
    const result = await initiateTeamsUpload(projectId, {
      serviceUrl: String(body.service_url ?? body.serviceUrl ?? ''),
      conversationId: String(body.conversation_id ?? body.conversationId ?? ''),
      botId: typeof body.bot_id === 'string' ? body.bot_id : undefined,
      filename: String(body.filename ?? ''),
      contentBase64: String(body.content_base64 ?? body.contentBase64 ?? ''),
      description: typeof body.description === 'string' ? body.description : undefined,
      conversationType:
        body.conversation_type === 'channel' || body.conversation_type === 'groupChat' || body.conversation_type === 'personal'
          ? body.conversation_type
          : undefined,
      teamGroupId: typeof body.team_group_id === 'string' && body.team_group_id ? body.team_group_id : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
    return c.json(result);
  },
);
