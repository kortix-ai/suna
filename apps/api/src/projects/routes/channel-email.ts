/**
 * Email channel (Resend Inboxes). Each inbox is an ACCOUNT of the project's
 * `kortix_email` connector: list, add, update and remove them here; default,
 * sharing and listing also work through the standard connection routes. The
 * `/installation` and `/connect` routes are the single-inbox surface from
 * before accounts; they act on the default inbox.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  type ResendDomain,
  createResendDomain,
  createResendInbox,
  deleteResendInbox,
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
  type EmailInboxAccount,
  type EmailSenderPolicy,
  emailConnectorState,
  insertEmailInboxAccount,
  listEmailInboxAccounts,
  listProjectsForWorkspace,
  loadDefaultEmailInboxAccount,
  loadEmailInboxAccount,
  normalizeSenderPolicy,
  releaseEmailInbox,
  reserveEmailInbox,
  revokeEmailInboxAccount,
  updateEmailInboxAccount,
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
import type { AppEnv } from '../../types';

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

export function registerChannelEmailRoutes(): void {
  // ─── Inboxes: the accounts of `kortix_email` ─────────────────────────────
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/channels/email/inboxes',
      tags: ['channels'],
      summary: 'List the email inboxes (accounts of the email connector)',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(z.any(), 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = c.req.param('projectId') ?? '';
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!emailChannelOn(loaded.row.metadata)) return c.json({ inboxes: [] });
      const accounts = (await listEmailInboxAccounts(projectId)).filter((a) => visibleTo(a, loaded.userId));
      return c.json({ inboxes: accounts.map(inboxView) });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/channels/email/inboxes',
      tags: ['channels'],
      summary: 'Add an email inbox (a new account of the email connector)',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 201: json(z.any(), 'Created'), ...errors(400, 403, 404, 409, 502, 503, 504) },
    }),
    async (c: Context<AppEnv>) => {
      const added = await addEmailInbox(c);
      // A helper's refusal is a plain Response; the route's typed union cannot name it.
      if ('response' in added) return added.response as never;
      return c.json(inboxView(added.account), 201);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/channels/email/inboxes/{connectionId}',
      tags: ['channels'],
      summary: 'Update an email inbox: who may email it, its agent, its names',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), connectionId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const target = await manageableInbox(c);
      if ('response' in target) return target.response as never;
      let body: Record<string, unknown>;
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      const patch: Parameters<typeof updateEmailInboxAccount>[1] = {};
      if (body.sender_policy !== undefined) {
        try {
          patch.senderPolicy = parseSenderPolicyBody(body.sender_policy);
        } catch (err) {
          return c.json({ error: (err as Error).message, code: 'invalid_sender_policy' }, 400);
        }
      }
      if (body.agent_name !== undefined) {
        const agent = await checkAgent(target.loaded, body.agent_name);
        if ('response' in agent) return c.json(agent.response.body, agent.response.status);
        patch.agentName = agent.agentName;
      }
      if (typeof body.display_name === 'string') patch.displayName = body.display_name.trim() || null;
      if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim();
      const updated = await updateEmailInboxAccount(target.account, patch);
      if (!updated) return c.json({ error: 'Inbox not found' }, 404);
      return c.json(inboxView(updated));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/channels/email/inboxes/{connectionId}',
      tags: ['channels'],
      summary: 'Remove an email inbox; deletes it on Resend when Kortix created it',
      ...auth,
      request: { params: z.object({ projectId: z.string(), connectionId: z.string() }) },
      responses: { 200: json(z.any(), 'OK'), ...errors(403, 404, 502, 504) },
    }),
    async (c: Context<AppEnv>) => {
      const target = await manageableInbox(c);
      if ('response' in target) return target.response as never;
      const removed = await removeEmailInbox(c, target.account);
      if (removed) return removed as never;
      return c.json({ status: 'deleted', inbox_deleted: target.account.createdByKortix });
    },
  );

  // ─── Before accounts: one inbox per project (acts on the default) ────────
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/channels/email/installation',
      tags: ['channels'],
      summary: 'Get the email channel installation (the default inbox)',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(z.any(), 'OK'), ...errors(404) },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = c.req.param('projectId') ?? '';
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!emailChannelOn(loaded.row.metadata)) return c.json(null);
      const account = await defaultVisibleInbox(projectId, loaded.userId);
      return c.json(account ? legacyInstallationView(account) : null);
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
      summary: 'Connect an email channel (adds a shared inbox)',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404, 409, 502, 503, 504) },
    }),
    async (c: Context<AppEnv>) => {
      const added = await addEmailInbox(c, { share: 'project' });
      if ('response' in added) return added.response as never;
      return c.json(legacyInstallationView(added.account));
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
      summary: 'Update the email channel (the default inbox)',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = c.req.param('projectId') ?? '';
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (!emailChannelOn(loaded.row.metadata)) return c.json(featureDisabledBody('email_channel'), 403);
      let body: { sender_policy?: unknown };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      let senderPolicy: EmailSenderPolicy;
      try {
        senderPolicy = parseSenderPolicyBody(body.sender_policy);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      const account = await loadDefaultEmailInboxAccount(projectId);
      if (!account) return c.json({ error: 'Email connection not found' }, 404);
      const updated = await updateEmailInboxAccount(account, { senderPolicy });
      return updated ? c.json(legacyInstallationView(updated)) : c.json({ error: 'Email connection not found' }, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/channels/email/installation',
      tags: ['channels'],
      summary: 'Disconnect the email channel (removes the default inbox)',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(z.any(), 'OK'), ...errors(404, 502) },
    }),
    async (c: Context<AppEnv>) => {
      const projectId = c.req.param('projectId') ?? '';
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      const account = await loadDefaultEmailInboxAccount(projectId);
      if (account) {
        const removed = await removeEmailInbox(c, account);
        if (removed) return removed as never;
      }
      return c.json({ status: 'disconnected' });
    },
  );
}

// ─── Inbox accounts ─────────────────────────────────────────────────────────

/** An inbox on the wire (snake_case, like the connection routes). */
function inboxView(a: EmailInboxAccount) {
  return {
    connection_id: a.connectionId,
    inbox_id: a.inboxId,
    email: a.email,
    display_name: a.displayName,
    label: a.label,
    owner_type: a.ownerType,
    owner_id: a.ownerId,
    is_default: a.isDefault,
    managed: a.managed,
    created_by_kortix: a.createdByKortix,
    sender_policy: {
      mode: a.senderPolicy.mode,
      allowed_emails: a.senderPolicy.allowedEmails,
      allowed_domains: a.senderPolicy.allowedDomains,
      allowed_regex: a.senderPolicy.allowedRegex,
    },
    agent_name: a.agentName,
    created_at: a.createdAt,
  };
}

/** The single-inbox shape the `/installation` routes always answered. */
function legacyInstallationView(a: EmailInboxAccount) {
  return {
    connectionSlug: 'kortix_email',
    inboxId: a.inboxId,
    email: a.email,
    displayName: a.displayName,
    webhookId: a.webhookId,
    senderPolicy: a.senderPolicy,
    createdByKortix: a.createdByKortix,
    installedAt: a.createdAt,
    connection_id: a.connectionId,
  };
}

/** A shared inbox is listed to every member; a private one to its owner only. */
function visibleTo(account: EmailInboxAccount, userId: string): boolean {
  return account.ownerType === 'project' || account.ownerId === userId;
}

async function defaultVisibleInbox(projectId: string, userId: string): Promise<EmailInboxAccount | null> {
  return (await listEmailInboxAccounts(projectId)).find((a) => visibleTo(a, userId)) ?? null;
}

/**
 * The inbox a PATCH/DELETE names, if the caller may manage it: a shared inbox
 * needs `connector.write`; a private one is its owner's.
 */
async function manageableInbox(
  c: Context<AppEnv>,
): Promise<{ response: Response } | { loaded: LoadedProject; account: EmailInboxAccount }> {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  if (!emailChannelOn(loaded.row.metadata)) return { response: c.json(featureDisabledBody('email_channel'), 403) };
  const account = await loadEmailInboxAccount(projectId, c.req.param('connectionId') ?? '');
  if (!account || !visibleTo(account, loaded.userId)) {
    return { response: c.json({ error: 'Inbox not found', code: 'email_inbox_not_found' }, 404) };
  }
  if (account.ownerType === 'project') {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  }
  return { loaded, account };
}

/** Delete on Resend what Kortix made, then revoke the account. A Resend failure keeps it. */
async function removeEmailInbox(c: Context<AppEnv>, account: EmailInboxAccount): Promise<Response | null> {
  try {
    await deleteEmailInbox(account);
  } catch (err) {
    return c.json(
      {
        error: `Resend could not delete the inbox ${account.email}. Try again; the inbox stays until it is deleted.`,
        code: emailUpstreamStatus(err) === 504 ? 'email_timeout' : 'email_upstream_error',
        provider: 'resend',
        upstream_status: emailUpstreamStatus(err),
      },
      502,
    );
  }
  await revokeEmailInboxAccount(account);
  await reconcileChannelConnectors(account.projectId);
  return null;
}

async function checkAgent(
  loaded: LoadedProject,
  requested: unknown,
): Promise<{ agentName: string | null } | { response: { body: Record<string, unknown>; status: 400 } }> {
  if (requested === null || requested === undefined) return { agentName: null };
  const agentName = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  if (!agentName) {
    return { response: { body: { error: 'agent_name cannot be blank', code: 'invalid_agent' }, status: 400 } };
  }
  const agents = await loadProjectAgents(loaded.row, { forceRefresh: true, rethrowReadErrors: true });
  if (!agents.specs.some((agent) => agent.enabled && agent.name === agentName)) {
    return {
      response: {
        body: { error: `Agent "${agentName}" is not declared or is disabled`, code: 'invalid_agent' },
        status: 400,
      },
    };
  }
  return { agentName };
}

/**
 * Add one inbox as an account of `kortix_email`: create it on Resend (or
 * attach one by id), make sure the team's webhook points here, claim it for
 * this project, materialize the connector on the first inbox, then insert the
 * account. A failure after Resend created the inbox deletes it again, so no
 * paid inbox is left without its account.
 */
async function addEmailInbox(
  c: Context<AppEnv>,
  options: { share?: 'me' | 'project' } = {},
): Promise<{ response: Response } | { account: EmailInboxAccount }> {
  const projectId = c.req.param('projectId') ?? '';
  // Floor 'read' (membership). A shared inbox also needs the connector.write
  // leaf; a private one ("only me") is the caller's own, like a private account.
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };

  let body: {
    api_key?: string;
    username?: string;
    domain?: string;
    inbox_id?: string;
    inboxId?: string;
    display_name?: string;
    displayName?: string;
    sender_policy?: unknown;
    agent_name?: string | null;
    agentName?: string | null;
    share?: string;
    label?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return { response: c.json({ error: 'Invalid JSON body' }, 400) };
  }
  const share = options.share ?? (body.share === 'me' ? 'me' : body.share === undefined || body.share === 'project' ? 'project' : null);
  if (!share) return { response: c.json({ error: 'share must be "me" or "project"', code: 'invalid_share' }, 400) };
  if (share === 'project') {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  }
  if (!emailChannelOn(loaded.row.metadata)) {
    return { response: c.json(featureDisabledBody('email_channel'), 403) };
  }

  const ownKey = body.api_key?.trim() || null;
  // Managed inboxes cost Kortix; only the operator switch offers them.
  if (!ownKey && !managedDomain()) return { response: c.json(keyRequiredBody(), 400) };
  const apiKey = ownKey ?? resolveEmailApiKey(null);
  if (!apiKey) return { response: c.json(keyRequiredBody(), 400) };

  const agent = await checkAgent(loaded, body.agent_name ?? body.agentName);
  if ('response' in agent) return { response: c.json(agent.response.body, agent.response.status) };
  const displayName = (body.display_name ?? body.displayName ?? loaded.row.name ?? 'Kortix Agent').trim();
  let senderPolicy: EmailSenderPolicy;
  try {
    senderPolicy = parseSenderPolicyBody(body.sender_policy);
  } catch (err) {
    return { response: c.json({ error: (err as Error).message }, 400) };
  }

  const existingInboxId =
    typeof (body.inbox_id ?? body.inboxId) === 'string' ? (body.inbox_id ?? body.inboxId)!.trim() : '';
  let inbox: { id: string; email_address: string; from_name?: string | null };
  if (existingInboxId) {
    // Ownership gate (pentest 2026-07-27): an inbox another project holds is
    // never attached here, or its inbound mail would resolve to this project.
    const owners = await listProjectsForWorkspace('email', existingInboxId);
    if (owners.length > 0) {
      return {
        response: c.json(
          {
            error: owners.some((id) => id !== projectId)
              ? 'This inbox is already connected to another project'
              : 'This inbox is already connected to this project',
            code: 'email_address_taken',
            provider: 'resend',
          },
          409,
        ),
      };
    }
    try {
      // Reading it with the key proves the inbox is the key's team's.
      inbox = await getResendInbox(apiKey, existingInboxId);
    } catch (err) {
      return { response: emailConnectError(c, err, 'inbox_attach') };
    }
  } else {
    const requestedDomain =
      typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim().toLowerCase() : null;
    // The managed key is Kortix's Resend team: its inboxes live on the managed
    // domain only, never on another domain that team happens to hold.
    if (!ownKey) {
      const managed = managedDomain()!;
      if (requestedDomain && requestedDomain !== managed) {
        return {
          response: c.json(
            {
              error: `Managed inboxes use ${managed}. Connect your own Resend API key to use ${requestedDomain}.`,
              code: 'email_domain_not_managed',
              provider: 'resend',
            },
            400,
          ),
        };
      }
    } else if (!requestedDomain) {
      return {
        response: c.json(
          { error: 'Pick one of your Resend domains for the inbox.', code: 'invalid_domain', provider: 'resend' },
          400,
        ),
      };
    }
    const domain = requestedDomain ?? managedDomain()!;
    const username = normalizeEmailUsername(body.username ?? loaded.row.name);
    if (!username) {
      return { response: c.json({ error: 'Enter a name before the @', code: 'invalid_username', provider: 'resend' }, 400) };
    }
    try {
      inbox = await createResendInbox({ apiKey, address: `${username}@${domain}`, fromName: displayName });
    } catch (err) {
      return { response: emailConnectError(c, err, 'inbox_create') };
    }
  }
  const createdByKortix = !existingInboxId;
  const undoCreate = async () => {
    if (createdByKortix) await deleteResendInbox(apiKey, inbox.id).catch(() => {});
  };

  let webhook: Awaited<ReturnType<typeof ensureResendInboxWebhook>>;
  try {
    webhook = await ensureResendInboxWebhook(apiKey, `${emailWebhookBaseUrl(c.req.url)}/v1/webhooks/email/resend`);
  } catch (err) {
    await undoCreate();
    return { response: emailConnectError(c, err, 'webhook_create') };
  }

  await reserveEmailInbox({ projectId, inboxId: inbox.id, email: inbox.email_address, agentName: agent.agentName });
  let connector = await emailConnectorState(projectId);
  if (!connector?.live) {
    // The first inbox materializes `kortix_email` (its claim is what the
    // channel materializer reads), and brings back one sync disabled when the
    // last inbox went.
    await reconcileChannelConnectors(projectId);
    connector = await emailConnectorState(projectId);
  }
  const connectorId = connector?.live ? connector.connectorId : null;
  if (!connectorId) {
    await releaseEmailInbox(projectId, inbox.id);
    await undoCreate();
    return {
      response: c.json(
        { error: 'The email connector could not be set up. Try again.', code: 'email_connector_unavailable', provider: 'resend' },
        503,
      ),
    };
  }
  const account = await insertEmailInboxAccount({
    accountId: loaded.row.accountId,
    projectId,
    connectorId,
    ownerType: share === 'me' ? 'member' : 'project',
    ownerId: share === 'me' ? loaded.userId : null,
    label: typeof body.label === 'string' ? body.label.trim() : null,
    inboxId: inbox.id,
    email: inbox.email_address,
    displayName: inbox.from_name ?? displayName,
    senderPolicy,
    agentName: agent.agentName,
    managed: !ownKey,
    createdByKortix,
    webhookId: webhook.id,
    apiKey: ownKey,
    webhookSecret: webhook.signing_secret,
    createdBy: loaded.userId,
  }).catch(async (err) => {
    await releaseEmailInbox(projectId, inbox.id);
    await undoCreate();
    throw err;
  });
  return { account };
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

function parseSenderPolicyBody(input: unknown): EmailSenderPolicy {
  const raw = (input ?? {}) as Record<string, unknown>;
  // Accepts the camelCase shape the single-inbox routes always took and the
  // snake_case one the inbox routes answer with.
  const policy = normalizeSenderPolicy({
    mode: raw.mode as EmailSenderPolicy['mode'] | undefined,
    allowedEmails: (raw.allowedEmails ?? raw.allowed_emails) as string[] | undefined,
    allowedDomains: (raw.allowedDomains ?? raw.allowed_domains) as string[] | undefined,
    allowedRegex: (raw.allowedRegex ?? raw.allowed_regex) as string | null | undefined,
  });
  if (policy.allowedRegex) compileEmailSenderRegex(policy.allowedRegex);
  return policy;
}
