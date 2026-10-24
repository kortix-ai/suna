/** Email channel (AgentMail): install, mode, connect, sender policy, and disconnect. */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  AGENTMAIL_DEFAULT_DOMAIN,
  type AgentMailDomain,
  agentMailProvisioningClientIds,
  agentMailRefusal,
  agentMailUpstreamStatus,
  createAgentMailDomain,
  createAgentMailInbox,
  createAgentMailWebhook,
  getAgentMailDomainSetupLink,
  isAgentMailInboxLimitError,
  listAgentMailDomains,
  resolveAgentMailApiKey,
  verifyAgentMailDomain,
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
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { loadProjectAgents } from '../agents';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadEmailInstallConnectionId } from '../lib/session-connector-bindings';
import type { AppEnv } from '../../types';

// ─── Email install — AgentMail-backed inbox per project ─────────────────────

export function registerChannelEmailRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/channels/email/installation',
      tags: ['channels'],
      summary: 'Get the email channel installation',
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
      summary: 'Get the email channel mode',
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
      // `enabled` stays on the wire for older clients: the channel graduated
      // from the `agentmail_email` flag (2026-10-24) and is on for every project.
      return c.json({
        provider: 'agentmail',
        enabled: true,
        managed_available: Boolean(config.AGENTMAIL_API_KEY),
        // Where a managed inbox lives: `<username>@<managed_domain>`.
        managed_domain: managedDomain(),
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/connect',
      tags: ['channels'],
      summary: 'Connect an email channel',
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
      const requestedDomain =
        typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim().toLowerCase() : undefined;
      // The managed key is Kortix's AgentMail account: its inboxes live on the
      // managed domain only, never on another domain that account happens to hold.
      const ownKey = Boolean(body.api_key?.trim());
      if (!ownKey && requestedDomain && requestedDomain !== managedDomain()) {
        return c.json(
          {
            error: `Managed inboxes use ${managedDomain()}. Connect your own AgentMail key to use ${requestedDomain}.`,
            code: 'agentmail_domain_not_managed',
          },
          400,
        );
      }
      const domainChoice = requestedDomain ?? (ownKey ? undefined : managedDomain());
      // AgentMail's default needs no `domain`; sending it explicitly is the same.
      const domain = domainChoice && domainChoice !== AGENTMAIL_DEFAULT_DOMAIN ? domainChoice : undefined;
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
          // A refused address (taken username, unverified domain) is the
          // user's to fix: say AgentMail's reason, not "upstream error".
          const status = agentMailUpstreamStatus(err);
          if (!isAgentMailInboxLimitError(err) && (status === 400 || status === 409 || status === 422)) {
            return c.json(
              {
                error: agentMailRefusal(err) ?? 'AgentMail refused this address.',
                code: 'agentmail_inbox_rejected',
                provider: 'agentmail',
                upstream_status: status,
                stage: 'inbox_create',
              },
              400,
            );
          }
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

  // ─── Domains: which addresses an AgentMail account can create ────────────
  // POST with the key in the body (never a query string, never logged). No key:
  // the managed account, which offers its one managed domain and nothing else.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/domains',
      tags: ['channels'],
      summary: 'List the email domains an AgentMail key can use',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 502, 503, 504),
      },
    }),
    async (c: Context<AppEnv>) => {
      const gate = await emailDomainsGate(c);
      if (gate.response) return gate.response;
      if (!gate.apiKey) {
        if (!config.AGENTMAIL_API_KEY) {
          return c.json({ error: 'AgentMail API key is not configured', code: 'agentmail_key_required' }, 503);
        }
        return c.json({
          managed: true,
          default_domain: managedDomain(),
          domains: [{ domain_id: null, domain: managedDomain(), status: 'VERIFIED', verified: true, records: [] }],
        });
      }
      try {
        const domains = await listAgentMailDomains(gate.apiKey);
        return c.json({
          managed: false,
          default_domain: AGENTMAIL_DEFAULT_DOMAIN,
          domains: [
            { domain_id: null, domain: AGENTMAIL_DEFAULT_DOMAIN, status: 'VERIFIED', verified: true, records: [] },
            ...domains.map(domainView),
          ],
        });
      } catch (err) {
        return agentMailDomainError(c, err);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/domains/add',
      tags: ['channels'],
      summary: 'Add a custom email domain to an AgentMail account',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 502, 504),
      },
    }),
    async (c: Context<AppEnv>) => {
      const gate = await emailDomainsGate(c, { ownKeyRequired: true });
      if (gate.response) return gate.response;
      const domain = typeof gate.body.domain === 'string' ? gate.body.domain.trim().toLowerCase() : '';
      if (!DOMAIN_PATTERN.test(domain)) {
        return c.json({ error: 'Enter a domain such as mail.example.com', code: 'invalid_domain' }, 400);
      }
      try {
        const created = await createAgentMailDomain(gate.apiKey!, domain);
        return c.json({ domain: domainView(created), setup: await setupLinkOrNull(gate.apiKey!, created) });
      } catch (err) {
        return agentMailDomainError(c, err);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/domains/verify',
      tags: ['channels'],
      summary: 'Check a custom email domain\'s DNS records again',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 403, 404, 502, 504),
      },
    }),
    async (c: Context<AppEnv>) => {
      const gate = await emailDomainsGate(c, { ownKeyRequired: true });
      if (gate.response) return gate.response;
      const domainId = typeof gate.body.domain_id === 'string' ? gate.body.domain_id.trim() : '';
      if (!domainId) return c.json({ error: 'domain_id is required', code: 'invalid_domain' }, 400);
      try {
        const checked = await verifyAgentMailDomain(gate.apiKey!, domainId);
        return c.json({ domain: domainView(checked), setup: await setupLinkOrNull(gate.apiKey!, checked) });
      } catch (err) {
        return agentMailDomainError(c, err);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/channels/email/installation',
      tags: ['channels'],
      summary: 'Update the email channel',
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
      summary: 'Disconnect the email channel',
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
}

/** The managed key's inbox domain (`AGENTMAIL_MANAGED_DOMAIN`), else AgentMail's own. */
function managedDomain(): string {
  return config.AGENTMAIL_MANAGED_DOMAIN?.trim().toLowerCase() || AGENTMAIL_DEFAULT_DOMAIN;
}

// A hostname with at least one dot: labels of letters, digits and inner hyphens.
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function domainView(domain: AgentMailDomain) {
  return {
    domain_id: domain.domain_id,
    domain: domain.domain,
    status: domain.status,
    verified: domain.status === 'VERIFIED',
    records: (domain.records ?? []).map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      status: r.status,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    })),
    ...(domain.reason ? { reason: domain.reason } : {}),
  };
}

/** One-click DNS setup for an unverified domain; null when verified or unsupported. */
async function setupLinkOrNull(apiKey: string, domain: AgentMailDomain) {
  if (domain.status === 'VERIFIED') return null;
  const link = await getAgentMailDomainSetupLink(apiKey, domain.domain_id).catch(() => null);
  if (!link?.supported || !link.url) return null;
  return {
    url: link.url,
    provider_name: link.provider_name ?? null,
    conflicting_provider: link.conflicting_provider ?? null,
  };
}

/** The domain routes' gate: membership, `connector.write`, and the request body. */
async function emailDomainsGate(
  c: Context<AppEnv>,
  options: { ownKeyRequired?: boolean } = {},
) {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) } as const;
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  let body: Record<string, unknown>;
  try {
    body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const apiKey = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : null;
  if (options.ownKeyRequired && !apiKey) {
    return {
      response: c.json(
        { error: 'Custom domains need your own AgentMail API key.', code: 'agentmail_key_required' },
        400,
      ),
    } as const;
  }
  return { response: null, apiKey, body } as const;
}

function agentMailDomainError(c: Context<AppEnv>, err: unknown) {
  const status = agentMailUpstreamStatus(err);
  if (status === 401 || status === 403) {
    return c.json(
      { error: 'AgentMail rejected this API key.', code: 'agentmail_key_rejected', provider: 'agentmail' },
      400,
    );
  }
  if (status !== null && status >= 400 && status < 500) {
    return c.json(
      {
        error: agentMailRefusal(err) ?? 'AgentMail refused the request.',
        code: 'agentmail_request_rejected',
        provider: 'agentmail',
        upstream_status: status,
      },
      400,
    );
  }
  return c.json(
    {
      error: status === 504 ? 'AgentMail did not answer in time. Try again.' : 'AgentMail is unreachable. Try again.',
      code: status === 504 ? 'agentmail_timeout' : 'agentmail_upstream_error',
      provider: 'agentmail',
    },
    status === 504 ? 504 : 502,
  );
}

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
