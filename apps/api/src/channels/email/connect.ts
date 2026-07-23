/**
 * Email (AgentMail) connect/onboarding logic, lifted out of the bespoke
 * `/channels/email/*` route handlers in projects/routes/r4.ts so the connector
 * descriptor (registry/email.ts) is the single owner of channel behavior. The
 * status codes and error bodies are preserved exactly (409 inbox-limit, 504
 * timeout, 502 upstream) via ChannelError.
 */
import { config } from '../../config';
import {
  type AgentMailSenderPolicy,
  normalizeSenderPolicy,
} from '../install-store';
import {
  AgentMailApiError,
  agentMailUpstreamStatus,
  createAgentMailInbox,
  createAgentMailWebhook,
  isAgentMailInboxLimitError,
  resolveAgentMailApiKey,
} from '../agentmail-api';
import { ChannelError } from '../registry/descriptor';

/** Default profile slug for the built-in email channel. */
export const EMAIL_DEFAULT_SLUG = 'kortix_email';

export function normalizeAgentMailUsername(input: string | null | undefined): string | null {
  const raw = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = raw.slice(0, 48).replace(/-+$/g, '');
  return trimmed || null;
}

// Static check for classic catastrophic-backtracking shapes — a quantified
// sub-group repeated by an outer quantifier (e.g. (x+)+, (x*)*) or an ambiguous
// repeated alternation (e.g. (a|a)*) — before a sender regex is persisted and
// later run against every inbound email sender.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)\s*[+*]/;
const DUPLICATE_ALTERNATION_RE = /\(([^()|]+)\|\1\)\s*[+*]/;

function hasCatastrophicBacktracking(pattern: string): boolean {
  return NESTED_QUANTIFIER_RE.test(pattern) || DUPLICATE_ALTERNATION_RE.test(pattern);
}

/** Validate + normalize an inbound sender-policy body. Throws ChannelError(400). */
export function parseSenderPolicyBody(
  input: Partial<AgentMailSenderPolicy> | undefined,
): AgentMailSenderPolicy {
  const policy = normalizeSenderPolicy(input);
  if (policy.allowedRegex) {
    try {
      new RegExp(policy.allowedRegex);
    } catch {
      throw new ChannelError(400, { error: 'Email sender regex is invalid' });
    }
    if (hasCatastrophicBacktracking(policy.allowedRegex)) {
      throw new ChannelError(400, {
        error:
          'Email sender regex is not allowed: nested or ambiguous repetition can cause catastrophic backtracking (ReDoS)',
      });
    }
  }
  return policy;
}

export function agentMailWebhookBaseUrl(requestUrl: string): string {
  return (config.KORTIX_URL || new URL(requestUrl).origin).replace(/\/+$/, '');
}

function agentMailConnectError(stage: 'inbox_create' | 'webhook_create', err: unknown): ChannelError {
  const upstreamStatus = agentMailUpstreamStatus(err);
  if (isAgentMailInboxLimitError(err)) {
    return new ChannelError(409, {
      error:
        'AgentMail inbox limit reached. Delete an unused AgentMail inbox or connect an existing AgentMail inbox with inbox_id and email.',
      code: 'agentmail_inbox_limit',
      provider: 'agentmail',
      upstream_status: upstreamStatus,
      stage,
    });
  }
  if (upstreamStatus === 504) {
    return new ChannelError(504, {
      error:
        stage === 'inbox_create'
          ? 'AgentMail inbox create timed out'
          : 'AgentMail webhook create timed out',
      code: 'agentmail_timeout',
      provider: 'agentmail',
      upstream_status: upstreamStatus,
      stage,
    });
  }
  return new ChannelError(502, {
    error:
      stage === 'inbox_create'
        ? `AgentMail inbox create failed: ${(err as Error).message}`
        : `AgentMail webhook create failed: ${(err as Error).message}`,
    code: 'agentmail_upstream_error',
    provider: 'agentmail',
    upstream_status: upstreamStatus,
    stage,
  });
}

export interface EmailConnectBody {
  api_key?: string;
  connector_slug?: string;
  profile_slug?: string;
  username?: string;
  domain?: string;
  inbox_id?: string;
  inboxId?: string;
  email?: string;
  display_name?: string;
  displayName?: string;
  sender_policy?: Partial<AgentMailSenderPolicy>;
}

export interface ResolvedEmailInbox {
  inbox_id: string;
  email: string;
  display_name?: string | null;
}

export interface PreparedEmailConnect {
  slug: string;
  apiKeyOverride: string | null;
  inbox: ResolvedEmailInbox;
  webhookId: string;
  webhookSecret: string;
  senderPolicy: AgentMailSenderPolicy;
}

/**
 * Provision (or attach an existing) AgentMail inbox + webhook for a connect
 * request. Pure of persistence — the descriptor saves the install + reconciles.
 * Throws ChannelError with the exact status the old handler returned.
 */
export async function prepareEmailConnect(args: {
  projectId: string;
  accountId: string;
  projectName: string | null;
  requestUrl: string;
  body: EmailConnectBody;
}): Promise<PreparedEmailConnect> {
  const { projectId, accountId, projectName, requestUrl, body } = args;

  const apiKey = resolveAgentMailApiKey(body.api_key?.trim());
  if (!apiKey) {
    throw new ChannelError(503, { error: 'AgentMail API key is not configured' });
  }

  const slug =
    (body.connector_slug ?? body.profile_slug ?? EMAIL_DEFAULT_SLUG).trim() || EMAIL_DEFAULT_SLUG;
  const displayName = (
    body.display_name ??
    body.displayName ??
    projectName ??
    'Kortix Agent'
  ).trim();
  const username = normalizeAgentMailUsername(body.username ?? projectName);

  const existingInboxId =
    typeof (body.inbox_id ?? body.inboxId) === 'string' ? (body.inbox_id ?? body.inboxId)!.trim() : '';
  const existingEmail = typeof body.email === 'string' ? body.email.trim() : '';
  if ((existingInboxId && !existingEmail) || (!existingInboxId && existingEmail)) {
    throw new ChannelError(400, {
      error: 'Existing AgentMail inbox requires both inbox_id and email',
    });
  }
  const domain =
    typeof body.domain === 'string' && body.domain.trim() ? body.domain.trim() : undefined;

  const senderPolicy = parseSenderPolicyBody(body.sender_policy);
  const clientId = `kortix-project-${projectId}`;

  let inbox: ResolvedEmailInbox;
  if (existingInboxId && existingEmail) {
    inbox = { inbox_id: existingInboxId, email: existingEmail, display_name: displayName };
  } else {
    try {
      inbox = await createAgentMailInbox({
        apiKey,
        username,
        domain,
        displayName,
        clientId,
        metadata: { provider: 'kortix', project_id: projectId, account_id: accountId },
      });
    } catch (err) {
      throw agentMailConnectError('inbox_create', err);
    }
  }

  let webhookId: string;
  let webhookSecret: string;
  try {
    const webhook = await createAgentMailWebhook({
      apiKey,
      inboxId: inbox.inbox_id,
      url: `${agentMailWebhookBaseUrl(requestUrl)}/v1/webhooks/email/agentmail`,
      clientId: `kortix-email-${projectId}`,
    });
    webhookId = webhook.webhook_id;
    webhookSecret = webhook.secret;
  } catch (err) {
    throw agentMailConnectError('webhook_create', err);
  }

  return {
    slug,
    apiKeyOverride: body.api_key?.trim() || null,
    inbox,
    webhookId,
    webhookSecret,
    senderPolicy,
  };
}

// Keep AgentMailApiError referenced for consumers importing from this module.
export { AgentMailApiError };
