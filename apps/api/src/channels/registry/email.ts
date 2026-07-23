/**
 * Email (AgentMail) connector provider descriptor. Ports the behavior of the
 * old `/channels/email/{installation,mode,connect}` + PATCH/DELETE handlers
 * onto the uniform ConnectorProviderDescriptor contract. Behavior — including
 * the `agentmail_email` experimental gate, the connector_slug/profile_slug
 * aliasing, and status codes — is preserved exactly.
 */
import { config } from '../../config';
import { resolveExperimentalFeature } from '../../experimental/features';
import {
  type AgentMailSenderPolicy,
  deleteAgentMailInstall,
  loadAgentMailInstall,
  saveAgentMailInstall,
  updateAgentMailSenderPolicy,
} from '../install-store';
import { loadEmailInstallProfileId } from '../../projects/lib/session-connector-bindings';
import { reconcileChannelConnectors } from '../../executor/sync';
import { ChannelError, type ChannelContext, type ConnectorProviderDescriptor } from './descriptor';
import {
  EMAIL_DEFAULT_SLUG,
  type EmailConnectBody,
  parseSenderPolicyBody,
  prepareEmailConnect,
} from '../email/connect';

function isEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'agentmail_email');
}

/** Shared 403 for a disabled experimental email channel. */
function assertEnabled(ctx: ChannelContext): void {
  if (!isEnabled(ctx.metadata)) {
    throw new ChannelError(403, {
      error: 'AgentMail Email is experimental and must be enabled for this project',
    });
  }
}

export const emailDescriptor: ConnectorProviderDescriptor = {
  platform: 'email',
  label: 'AgentMail Email',
  reservedSlug: EMAIL_DEFAULT_SLUG,
  defaultSlug: EMAIL_DEFAULT_SLUG,
  direction: 'inbound',
  isEnabled,

  async getMode(ctx) {
    const enabled = isEnabled(ctx.metadata);
    return {
      provider: 'agentmail',
      enabled,
      managed_available: enabled && Boolean(config.AGENTMAIL_API_KEY),
    };
  },

  async getInstallation(ctx, slug) {
    // Disabled channel reads as "no install" (never 403 a read), matching the
    // old GET handler which returned null when the flag was off.
    if (!isEnabled(ctx.metadata)) return null;
    const install = await loadAgentMailInstall(ctx.projectId, slug);
    if (!install) return null;
    return {
      ...install,
      profile_id: await loadEmailInstallProfileId(ctx.projectId, install.inboxId),
    };
  },

  async connect(ctx, _slug, body) {
    assertEnabled(ctx);
    const prepared = await prepareEmailConnect({
      projectId: ctx.projectId,
      accountId: ctx.accountId,
      projectName: ctx.projectName,
      requestUrl: ctx.requestUrl,
      body: (body ?? {}) as EmailConnectBody,
    });
    const summary = await saveAgentMailInstall({
      projectId: ctx.projectId,
      profileSlug: prepared.slug,
      apiKey: prepared.apiKeyOverride,
      inboxId: prepared.inbox.inbox_id,
      email: prepared.inbox.email,
      displayName: prepared.inbox.display_name ?? null,
      webhookId: prepared.webhookId,
      webhookSecret: prepared.webhookSecret,
      senderPolicy: prepared.senderPolicy,
    });
    await reconcileChannelConnectors(ctx.projectId);
    return {
      ...summary,
      profile_id: await loadEmailInstallProfileId(ctx.projectId, summary.inboxId),
    };
  },

  async disconnect(ctx, slug) {
    await deleteAgentMailInstall(ctx.projectId, slug);
    await reconcileChannelConnectors(ctx.projectId, { platform: 'email', slug });
  },

  capabilities: {
    /** PATCH the sender policy for an existing email install. */
    updatePolicy: {
      method: 'put',
      access: 'write',
      async handler(ctx, input, _c) {
        assertEnabled(ctx);
        const body = (input ?? {}) as {
          connector_slug?: string;
          profile_slug?: string;
          sender_policy?: Partial<AgentMailSenderPolicy>;
        };
        const slug =
          (body.connector_slug ?? body.profile_slug ?? EMAIL_DEFAULT_SLUG).trim() ||
          EMAIL_DEFAULT_SLUG;
        const senderPolicy = parseSenderPolicyBody(body.sender_policy);
        const summary = await updateAgentMailSenderPolicy(ctx.projectId, slug, senderPolicy);
        if (!summary) throw new ChannelError(404, { error: 'Email channel profile not found' });
        return summary;
      },
    },
  },
};
