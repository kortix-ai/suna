/** Email channel (Resend Inboxes): install, mode, connect, domains, sender policy, disconnect. */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  type ResendDomain,
  createResendDomain,
  createResendInbox,
  emailUpstreamStatus,
  ensureResendInboxWebhook,
  getResendInbox,
  listResendDomains,
  resendDomainReady,
  resendRefusal,
  resolveEmailApiKey,
  verifyResendDomain,
} from '../../channels/resend-email-api';
import { deleteEmailInbox } from '../../channels/email/inbox-delete';
import { compileEmailSenderRegex } from '../../channels/email/sender-policy-regex';
import {
  type EmailSenderPolicy,
  deleteEmailInstall,
  listProjectsForWorkspace,
  loadEmailInstall,
  normalizeSenderPolicy,
  saveEmailInstall,
  updateEmailSenderPolicy,
} from '../../channels/install-store';
import { config } from '../../config';
import { featureDisabledBody } from '../../feature-flags/gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { reconcileChannelConnectors } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { loadProjectAgents } from '../agents';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadEmailInstallConnectionId } from '../lib/session-connector-bindings';
import type { AppEnv } from '../../types';

// ─── Email install — a Resend inbox per connection ──────────────────────────

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
      if (!emailChannelOn(loaded.row.metadata)) return c.json(null);
      const connectorSlug = c.req.query('connector_slug') || 'kortix_email';
      const install = await loadEmailInstall(projectId, connectorSlug);
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
      // A managed inbox needs the operator switch, Kortix's Resend team AND
      // its receiving domain. Bring-your-own key works whenever the channel is on.
      const managed = managedDomain();
      return c.json({
        provider: 'resend',
        enabled: emailChannelOn(loaded.row.metadata),
        managed_available: Boolean(managed),
        // Where a managed inbox lives: `<username>@<managed_domain>`.
        managed_domain: managed,
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
      if (!emailChannelOn(loaded.row.metadata)) {
        return c.json(featureDisabledBody('email_channel'), 403);
      }

      let body: {
        api_key?: string;
        connector_slug?: string;
        username?: string;
        domain?: string;
        inbox_id?: string;
        inboxId?: string;
        display_name?: string;
        displayName?: string;
        sender_policy?: Partial<EmailSenderPolicy>;
        agent_name?: string | null;
        agentName?: string | null;
      };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      const ownKey = body.api_key?.trim() || null;
      // Managed inboxes cost Kortix; only the operator switch offers them.
      if (!ownKey && !managedDomain()) return c.json(keyRequiredBody(), 400);
      const apiKey = ownKey ?? resolveEmailApiKey(null);
      if (!apiKey) return c.json(keyRequiredBody(), 400);

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
      let senderPolicy: EmailSenderPolicy;
      try {
        senderPolicy = parseSenderPolicyBody(body.sender_policy);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      const existingInboxId =
        typeof (body.inbox_id ?? body.inboxId) === 'string' ? (body.inbox_id ?? body.inboxId)!.trim() : '';
      let inbox: { id: string; email_address: string; from_name?: string | null };
      if (existingInboxId) {
        // Ownership gate (pentest 2026-07-27): before claiming an existing
        // inbox, confirm no OTHER project already owns it. Without this, a
        // caller with connector.write on their own project could supply a
        // victim's inbox_id and hijack inbound mail resolution. The scoped
        // delete in saveEmailInstall is defense-in-depth; this 409 is the gate.
        const owners = await listProjectsForWorkspace('email', existingInboxId);
        if (owners.some((id) => id !== projectId)) {
          return c.json(
            { error: 'This inbox is already connected to another project', code: 'email_address_taken', provider: 'resend' },
            409,
          );
        }
        try {
          // Reading it with the key proves the inbox is the key's team's.
          inbox = await getResendInbox(apiKey, existingInboxId);
        } catch (err) {
          return emailConnectError(c, err, 'inbox_attach');
        }
      } else {
        const requestedDomain =
          typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim().toLowerCase() : null;
        // The managed key is Kortix's Resend team: its inboxes live on the
        // managed domain only, never on another domain that team happens to hold.
        if (!ownKey) {
          const managed = managedDomain();
          if (!managed) {
            return c.json(
              { error: 'Managed email has no domain on this server. Connect your own Resend API key.', code: 'email_domain_not_ready', provider: 'resend' },
              503,
            );
          }
          if (requestedDomain && requestedDomain !== managed) {
            return c.json(
              {
                error: `Managed inboxes use ${managed}. Connect your own Resend API key to use ${requestedDomain}.`,
                code: 'email_domain_not_managed',
                provider: 'resend',
              },
              400,
            );
          }
        } else if (!requestedDomain) {
          return c.json(
            { error: 'Pick one of your Resend domains for the inbox.', code: 'invalid_domain', provider: 'resend' },
            400,
          );
        }
        const domain = requestedDomain ?? managedDomain()!;
        const username = normalizeEmailUsername(body.username ?? loaded.row.name);
        if (!username) {
          return c.json({ error: 'Enter a name before the @', code: 'invalid_username', provider: 'resend' }, 400);
        }
        try {
          inbox = await createResendInbox({ apiKey, address: `${username}@${domain}`, fromName: displayName });
        } catch (err) {
          return emailConnectError(c, err, 'inbox_create');
        }
      }

      let webhook: Awaited<ReturnType<typeof ensureResendInboxWebhook>>;
      try {
        webhook = await ensureResendInboxWebhook(apiKey, `${emailWebhookBaseUrl(c.req.url)}/v1/webhooks/email/resend`);
      } catch (err) {
        return emailConnectError(c, err, 'webhook_create');
      }

      const summary = await saveEmailInstall({
        projectId,
        connectionSlug: connectorSlug,
        apiKey: ownKey,
        inboxId: inbox.id,
        email: inbox.email_address,
        displayName: inbox.from_name ?? displayName,
        webhookId: webhook.id,
        webhookSecret: webhook.signing_secret,
        senderPolicy,
        // Attached by id: the person's inbox, only unlinked on disconnect.
        createdByKortix: !existingInboxId,
        agentName,
      });
      await reconcileChannelConnectors(projectId);
      return c.json({
        ...summary,
        connection_id: await loadEmailInstallConnectionId(projectId, summary.inboxId),
      });
    },
  );

  // ─── Domains: which addresses a Resend team can create inboxes on ───────
  // POST with the key in the body (never a query string, never logged). No key:
  // the managed team, which offers its one managed domain and nothing else.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/domains',
      tags: ['channels'],
      summary: 'List the email domains a Resend key can use',
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
        const managed = managedDomain();
        if (!managed) return c.json(keyRequiredBody(), 400);
        return c.json({
          managed: true,
          default_domain: managed,
          domains: [{ domain_id: null, domain: managed, status: 'VERIFIED', verified: true, records: [] }],
        });
      }
      try {
        const domains = await listResendDomains(gate.apiKey);
        const views = domains.map(domainView);
        return c.json({
          managed: false,
          default_domain: views.find((d) => d.verified)?.domain ?? null,
          domains: views,
        });
      } catch (err) {
        return emailDomainError(c, err);
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/domains/add',
      tags: ['channels'],
      summary: 'Add a custom email domain to a Resend team',
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
        const created = await createResendDomain(gate.apiKey!, domain);
        return c.json({ domain: domainView(created), setup: null });
      } catch (err) {
        return emailDomainError(c, err);
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
        const checked = await verifyResendDomain(gate.apiKey!, domainId);
        return c.json({ domain: domainView(checked), setup: null });
      } catch (err) {
        return emailDomainError(c, err);
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
      if (!emailChannelOn(loaded.row.metadata)) {
        return c.json(featureDisabledBody('email_channel'), 403);
      }
      let body: {
        connector_slug?: string;
        sender_policy?: Partial<EmailSenderPolicy>;
      };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      const connectorSlug = (body.connector_slug ?? 'kortix_email').trim() || 'kortix_email';
      let senderPolicy: EmailSenderPolicy;
      try {
        senderPolicy = parseSenderPolicyBody(body.sender_policy);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      const summary = await updateEmailSenderPolicy(projectId, connectorSlug, senderPolicy);
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
        ...errors(404, 502),
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
      // The inbox Kortix created goes with the install: a disconnected inbox
      // must not keep billing. A Resend failure keeps the install to retry.
      const install = await loadEmailInstall(projectId, connectorSlug);
      if (install) {
        try {
          await deleteEmailInbox(projectId, install);
        } catch (err) {
          return c.json(
            {
              error: `Resend could not delete the inbox ${install.email}. Try again; the connection stays until it is deleted.`,
              code: emailUpstreamStatus(err) === 504 ? 'email_timeout' : 'email_upstream_error',
              provider: 'resend',
              upstream_status: emailUpstreamStatus(err),
            },
            502,
          );
        }
      }
      await deleteEmailInstall(projectId, connectorSlug);
      await reconcileChannelConnectors(projectId, {
        platform: 'email',
        slug: connectorSlug,
      });
      return c.json({ status: 'disconnected' });
    },
  );
}

/** Whether the project has the email channel (`email_channel`). */
function emailChannelOn(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'email_channel');
}

/** Where to get a key and how Resend Inboxes work. */
const RESEND_API_KEYS_URL = 'https://resend.com/api-keys';
const RESEND_INBOXES_DOCS_URL = 'https://resend.com/docs/dashboard/inboxes/introduction';

function keyRequiredBody(lead = 'Connect your own Resend API key.') {
  return {
    error: `${lead} Create one at ${RESEND_API_KEYS_URL}. How inboxes work: ${RESEND_INBOXES_DOCS_URL}`,
    code: 'email_key_required',
    provider: 'resend',
    api_keys_url: RESEND_API_KEYS_URL,
    docs_url: RESEND_INBOXES_DOCS_URL,
  };
}

/**
 * The managed team's inbox domain, or null when this server offers no managed
 * inbox: the operator switch `RESEND_MANAGED_EMAIL_ENABLED`, Kortix's
 * `RESEND_API_KEY` and `RESEND_MANAGED_DOMAIN` are all needed.
 */
function managedDomain(): string | null {
  if (!config.RESEND_MANAGED_EMAIL_ENABLED || !config.RESEND_API_KEY) return null;
  return config.RESEND_MANAGED_DOMAIN?.trim().toLowerCase() || null;
}

// A hostname with at least one dot: labels of letters, digits and inner hyphens.
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Resend's domain status, in the wire vocabulary the clients already read. */
const DOMAIN_STATUS: Record<string, string> = {
  not_started: 'NOT_STARTED',
  pending: 'PENDING',
  verified: 'VERIFIED',
  failed: 'FAILED',
  temporary_failure: 'PENDING',
};
const RECORD_STATUS: Record<string, string> = {
  verified: 'VALID',
  failed: 'INVALID',
  temporary_failure: 'MISSING',
  pending: 'MISSING',
  not_started: 'MISSING',
};

/**
 * One domain as the connect form shows it. `verified` means an inbox can live
 * there: Resend verified it AND it receives. A verified domain that only
 * sends reads as pending, so the form offers "Check again", which switches
 * receiving on and adds the MX record.
 */
function domainView(domain: ResendDomain) {
  const ready = resendDomainReady(domain);
  return {
    domain_id: domain.id,
    domain: domain.name,
    status: ready ? 'VERIFIED' : domain.status === 'verified' ? 'PENDING' : (DOMAIN_STATUS[domain.status] ?? 'PENDING'),
    verified: ready,
    records: (domain.records ?? []).map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      status: RECORD_STATUS[r.status ?? ''] ?? 'MISSING',
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    })),
    ...(domain.status === 'verified' && !ready
      ? { reason: 'Receiving is off for this domain. Check again to turn it on and get its MX record.' }
      : {}),
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
  if (!emailChannelOn(loaded.row.metadata)) {
    return { response: c.json(featureDisabledBody('email_channel'), 403) } as const;
  }
  let body: Record<string, unknown>;
  try {
    body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const apiKey = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : null;
  if (options.ownKeyRequired && !apiKey) {
    return { response: c.json(keyRequiredBody('Custom domains need your own Resend API key.'), 400) } as const;
  }
  return { response: null, apiKey, body } as const;
}

/** Resend answers 401, and 403 with a key message, for a key it does not accept. */
function keyRejected(err: unknown): boolean {
  const status = emailUpstreamStatus(err);
  if (status === 401) return true;
  if (status !== 403) return false;
  const reason = (resendRefusal(err) ?? '').toLowerCase();
  const name = String((err as { body?: { name?: unknown } }).body?.name ?? '').toLowerCase();
  return reason.includes('api key') || name.includes('api_key');
}

function upstreamFailure(c: Context<AppEnv>, err: unknown) {
  const status = emailUpstreamStatus(err);
  return c.json(
    {
      error: status === 504 ? 'Resend did not answer in time. Try again.' : 'Resend is unreachable. Try again.',
      code: status === 504 ? 'email_timeout' : 'email_upstream_error',
      provider: 'resend',
      upstream_status: status,
    },
    status === 504 ? 504 : 502,
  );
}

function emailDomainError(c: Context<AppEnv>, err: unknown) {
  const status = emailUpstreamStatus(err);
  if (keyRejected(err)) {
    return c.json({ error: 'Resend rejected this API key.', code: 'email_key_rejected', provider: 'resend' }, 400);
  }
  if (status !== null && status >= 400 && status < 500) {
    return c.json(
      {
        error: resendRefusal(err) ?? 'Resend refused the request.',
        code: 'email_inbox_rejected',
        provider: 'resend',
        upstream_status: status,
      },
      400,
    );
  }
  return upstreamFailure(c, err);
}

/** A refused connect, in the words the person can act on. */
function emailConnectError(
  c: Context<AppEnv>,
  err: unknown,
  stage: 'inbox_create' | 'inbox_attach' | 'webhook_create',
) {
  const status = emailUpstreamStatus(err);
  const reason = resendRefusal(err);
  if (keyRejected(err)) {
    return c.json({ error: 'Resend rejected this API key.', code: 'email_key_rejected', provider: 'resend', stage }, 400);
  }
  if (stage === 'inbox_create' && status === 409) {
    return c.json(
      { error: reason ?? 'That address is already in use. Pick another name.', code: 'email_address_taken', provider: 'resend', upstream_status: status, stage },
      409,
    );
  }
  if (stage === 'inbox_create' && status === 422) {
    return c.json(
      {
        error: reason ?? 'This domain cannot receive email yet. Verify it and turn receiving on.',
        code: 'email_domain_not_ready',
        provider: 'resend',
        upstream_status: status,
        stage,
      },
      400,
    );
  }
  if (stage === 'inbox_create' && status === 403) {
    return c.json(
      {
        error: 'The Resend team reached its inbox limit. Enable pay-as-you-go inboxes in Resend, or remove an unused inbox.',
        code: 'email_inbox_limit',
        provider: 'resend',
        upstream_status: status,
        stage,
      },
      409,
    );
  }
  if (status !== null && status >= 400 && status < 500) {
    return c.json(
      { error: reason ?? 'Resend refused this inbox.', code: 'email_inbox_rejected', provider: 'resend', upstream_status: status, stage },
      400,
    );
  }
  return upstreamFailure(c, err);
}

function emailWebhookBaseUrl(requestUrl: string): string {
  return (config.KORTIX_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
}

/** The part before the @: lower case, letters, digits, dots and hyphens. */
export function normalizeEmailUsername(input: string | null | undefined): string | null {
  const raw = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  const trimmed = raw.slice(0, 48).replace(/[-.]+$/g, '');
  return trimmed || null;
}

function parseSenderPolicyBody(input: Partial<EmailSenderPolicy> | undefined): EmailSenderPolicy {
  const policy = normalizeSenderPolicy(input);
  if (policy.allowedRegex) compileEmailSenderRegex(policy.allowedRegex);
  return policy;
}
