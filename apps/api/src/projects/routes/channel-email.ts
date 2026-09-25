/** Email channel (AgentMail): install, mode, connect, sender policy, and disconnect. */
import { createRoute, z } from '@hono/zod-openapi';
import {
  agentMailProvisioningClientIds,
  agentMailUpstreamStatus,
  createAgentMailInbox,
  createAgentMailWebhook,
  isAgentMailInboxLimitError,
  resolveAgentMailApiKey,
} from '../../channels/agentmail-api';
import { compileEmailSenderRegex } from '../../channels/email/sender-policy-regex';
import {
  type AgentMailSenderPolicy,
  deleteAgentMailInstall,
  listProjectsForWorkspace,
  loadAgentMailInstall,
  normalizeSenderPolicy,
  saveAgentMailInstall,
  updateAgentMailSenderPolicy,
} from '../../channels/install-store';
import { config } from '../../config';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { featureDisabledBody } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { loadProjectAgents } from '../agents';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadEmailInstallConnectionId } from '../lib/session-connector-bindings';

// ─── Email install — AgentMail-backed inbox per project ─────────────────────

function emailChannelEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'agentmail_email');
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/email/installation',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/email/installation',
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
    if (!emailChannelEnabled(loaded.row.metadata)) return c.json(null);
    const connectorSlug = c.req.query('connector_slug') || 'kortix_email';
    const install = await loadAgentMailInstall(projectId, connectorSlug);
    if (!install) return c.json(null);
    return c.json({
      ...install,
      connection_id: await loadEmailInstallConnectionId(projectId, install.inboxId),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/channels/email/mode',
    tags: ['channels'],
    summary: 'GET /:projectId/channels/email/mode',
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
    const enabled = emailChannelEnabled(loaded.row.metadata);
    return c.json({
      provider: 'agentmail',
      enabled,
      managed_available: enabled && Boolean(config.AGENTMAIL_API_KEY),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/channels/email/connect',
    tags: ['channels'],
    summary: 'POST /:projectId/channels/email/connect',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409, 502, 503, 504),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read' (membership); the connector.write leaf below is the real gate,
    // so a custom role that unchecks connector.write is denied even if it holds
    // project.write. The built-in manager role holds the leaf.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!emailChannelEnabled(loaded.row.metadata)) {
      return c.json(featureDisabledBody('agentmail_email'), 403);
    }

    let body: {
      api_key?: string;
      connector_slug?: string;
      username?: string;
      domain?: string;
      inbox_id?: string;
      inboxId?: string;
      email?: string;
      display_name?: string;
      displayName?: string;
      sender_policy?: Partial<AgentMailSenderPolicy>;
      agent_name?: string | null;
      agentName?: string | null;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const apiKey = resolveAgentMailApiKey(body.api_key?.trim());
    if (!apiKey) {
      return c.json({ error: 'AgentMail API key is not configured' }, 503);
    }

    const connectorSlug = (body.connector_slug ?? 'kortix_email').trim() || 'kortix_email';
    const requestedAgent = body.agent_name ?? body.agentName;
    const agentName =
      typeof requestedAgent === 'string' && requestedAgent.trim() ? requestedAgent.trim() : null;
    if (requestedAgent !== undefined && requestedAgent !== null && !agentName) {
      return c.json({ error: 'agent_name cannot be blank', code: 'invalid_agent' }, 400);
    }
    if (agentName) {
      const loadedAgents = await loadProjectAgents(loaded.row, {
        forceRefresh: true,
        rethrowReadErrors: true,
      });
      if (!loadedAgents.specs.some((agent) => agent.enabled && agent.name === agentName)) {
        return c.json(
          {
            error: `Agent "${agentName}" is not declared or is disabled`,
            code: 'invalid_agent',
          },
          400,
        );
      }
    }
    const displayName = (
      body.display_name ??
      body.displayName ??
      loaded.row.name ??
      'Kortix Agent'
    ).trim();
    const username = normalizeAgentMailUsername(body.username ?? loaded.row.name);
    const existingInboxId =
      typeof (body.inbox_id ?? body.inboxId) === 'string'
        ? (body.inbox_id ?? body.inboxId)!.trim()
        : '';
    const existingEmail = typeof body.email === 'string' ? body.email.trim() : '';
    if ((existingInboxId && !existingEmail) || (!existingInboxId && existingEmail)) {
      return c.json({ error: 'Existing AgentMail inbox requires both inbox_id and email' }, 400);
    }
    const domain =
      typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : undefined;
    let senderPolicy: AgentMailSenderPolicy;
    try {
      senderPolicy = parseSenderPolicyBody(body.sender_policy);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const clientIds = agentMailProvisioningClientIds(projectId, connectorSlug);

    let inbox: Awaited<ReturnType<typeof createAgentMailInbox>>;
    if (existingInboxId && existingEmail) {
      // Ownership gate (pentest 2026-07-27): before claiming an existing
      // AgentMail inbox, confirm no OTHER project already owns it. Without this,
      // a caller with connector.write on their own project could supply a
      // victim's inbox_id and hijack inbound mail resolution. The scoped delete
      // in saveAgentMailInstall is defense-in-depth; this 409 is the front gate.
      const owners = await listProjectsForWorkspace('email', existingInboxId);
      const foreignOwner = owners.find((id) => id !== projectId);
      if (foreignOwner) {
        return c.json({ error: 'AgentMail inbox is already connected to another project' }, 409);
      }
      inbox = {
        inbox_id: existingInboxId,
        email: existingEmail,
        display_name: displayName,
      };
    } else {
      try {
        inbox = await createAgentMailInbox({
          apiKey,
          username,
          domain,
          displayName,
          clientId: clientIds.inbox,
          metadata: {
            provider: 'kortix',
            project_id: projectId,
            account_id: loaded.row.accountId,
          },
        });
      } catch (err) {
        return c.json(
          agentMailConnectErrorBody('inbox_create', err),
          agentMailConnectErrorStatus(err),
        );
      }
    }

    let webhookId: string;
    let webhookSecret: string;
    try {
      const webhook = await createAgentMailWebhook({
        apiKey,
        inboxId: inbox.inbox_id,
        url: `${agentMailWebhookBaseUrl(c.req.url)}/v1/webhooks/email/agentmail`,
        clientId: clientIds.webhook,
      });
      webhookId = webhook.webhook_id;
      webhookSecret = webhook.secret;
    } catch (err) {
      return c.json(
        agentMailConnectErrorBody('webhook_create', err),
        agentMailConnectErrorStatus(err),
      );
    }

    const summary = await saveAgentMailInstall({
      projectId,
      connectionSlug: connectorSlug,
      apiKey: body.api_key?.trim() || null,
      inboxId: inbox.inbox_id,
      email: inbox.email,
      displayName: inbox.display_name ?? displayName,
      webhookId,
      webhookSecret,
      senderPolicy,
      agentName,
    });
    await reconcileChannelConnectors(projectId);
    return c.json({
      ...summary,
      connection_id: await loadEmailInstallConnectionId(projectId, summary.inboxId),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/channels/email/installation',
    tags: ['channels'],
    summary: 'PATCH /:projectId/channels/email/installation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.connector.write is the real gate (see /email/connect).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    if (!emailChannelEnabled(loaded.row.metadata)) {
      return c.json(featureDisabledBody('agentmail_email'), 403);
    }
    let body: {
      connector_slug?: string;
      sender_policy?: Partial<AgentMailSenderPolicy>;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const connectorSlug = (body.connector_slug ?? 'kortix_email').trim() || 'kortix_email';
    let senderPolicy: AgentMailSenderPolicy;
    try {
      senderPolicy = parseSenderPolicyBody(body.sender_policy);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const summary = await updateAgentMailSenderPolicy(projectId, connectorSlug, senderPolicy);
    if (!summary) return c.json({ error: 'Email connection not found' }, 404);
    return c.json(summary);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/channels/email/installation',
    tags: ['channels'],
    summary: 'DELETE /:projectId/channels/email/installation',
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
    // Floor 'read'; project.connector.write is the real gate (see /email/connect).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    );
    const connectorSlug = c.req.query('connector_slug') || 'kortix_email';
    await deleteAgentMailInstall(projectId, connectorSlug);
    await reconcileChannelConnectors(projectId, {
      platform: 'email',
      slug: connectorSlug,
    });
    return c.json({ status: 'disconnected' });
  },
);

function agentMailWebhookBaseUrl(requestUrl: string): string {
  return (config.KORTIX_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
}

function normalizeAgentMailUsername(input: string | null | undefined): string | null {
  const raw = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = raw.slice(0, 48).replace(/-+$/g, '');
  return trimmed || null;
}

function parseSenderPolicyBody(
  input: Partial<AgentMailSenderPolicy> | undefined,
): AgentMailSenderPolicy {
  const policy = normalizeSenderPolicy(input);
  if (policy.allowedRegex) compileEmailSenderRegex(policy.allowedRegex);
  return policy;
}

function agentMailConnectErrorStatus(err: unknown): 409 | 502 | 504 {
  if (isAgentMailInboxLimitError(err)) return 409;
  if (agentMailUpstreamStatus(err) === 504) return 504;
  return 502;
}

function agentMailConnectErrorBody(stage: 'inbox_create' | 'webhook_create', err: unknown) {
  const upstreamStatus = agentMailUpstreamStatus(err);
  if (isAgentMailInboxLimitError(err)) {
    return {
      error:
        'AgentMail inbox limit reached. Delete an unused AgentMail inbox or connect an existing AgentMail inbox with inbox_id and email.',
      code: 'agentmail_inbox_limit',
      provider: 'agentmail',
      upstream_status: upstreamStatus,
      stage,
    };
  }
  if (upstreamStatus === 504) {
    return {
      error:
        stage === 'inbox_create'
          ? 'AgentMail inbox create timed out'
          : 'AgentMail webhook create timed out',
      code: 'agentmail_timeout',
      provider: 'agentmail',
      upstream_status: upstreamStatus,
      stage,
    };
  }
  return {
    error:
      stage === 'inbox_create'
        ? `AgentMail inbox create failed: ${(err as Error).message}`
        : `AgentMail webhook create failed: ${(err as Error).message}`,
    code: 'agentmail_upstream_error',
    provider: 'agentmail',
    upstream_status: upstreamStatus,
    stage,
  };
}
