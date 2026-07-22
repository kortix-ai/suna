/**
 * Slack connector provider descriptor. Ports the behavior of the old
 * `/channels/slack/{installation,mode,connect,file,file/upload,bind-thread}`
 * handlers onto the uniform ConnectorProviderDescriptor contract. Behavior —
 * including the single-install-per-project shape (no connector_slug/profile_slug
 * aliasing like email) and status codes — is preserved exactly. Slack has no
 * experimental gate: it is always enabled.
 *
 * NOTE: the per-project Slack app *manifest* is NOT a capability here — it stays
 * at its existing PUBLIC webhook route (GET /v1/webhooks/slack/:projectId/manifest)
 * because the in-sandbox `kortix-agent slack manifest` command fetches it
 * unauthenticated. That route is untouched by this refactor.
 */
import {
  deleteSlackInstall,
  loadSlackInstall,
  saveSlackInstall,
} from '../install-store';
import { buildSlackInstallUrl } from '../slack-oauth';
import { slackOauthMode } from '../slack-oauth-mode';
import { bindChatThread } from '../slack/binding';
import { downloadSlackFile, uploadSlackFile } from '../slack/file-proxy';
import { reconcileChannelConnectors } from '../../executor/sync';
import { ChannelError, type ConnectorProviderDescriptor } from './descriptor';
import {
  SLACK_DEFAULT_SLUG,
  type SlackBindThreadBody,
  type SlackConnectBody,
  prepareSlackConnect,
  resolveBindThreadTarget,
} from '../slack/connect';

export const slackDescriptor: ConnectorProviderDescriptor = {
  platform: 'slack',
  label: 'Slack',
  reservedSlug: SLACK_DEFAULT_SLUG,
  defaultSlug: SLACK_DEFAULT_SLUG,
  direction: 'inbound',
  // Slack has no experimental flag — always enabled.
  isEnabled: () => true,

  async getMode(ctx) {
    const mode = slackOauthMode();
    if (!mode.available) {
      return { oauth_available: false, install_url: null };
    }
    try {
      const installUrl = buildSlackInstallUrl(ctx.projectId, ctx.userId);
      return { oauth_available: true, install_url: installUrl };
    } catch {
      return { oauth_available: false, install_url: null };
    }
  },

  async getInstallation(ctx, _slug) {
    // Single install per project (no per-slug profiles, unlike email).
    const install = await loadSlackInstall(ctx.projectId);
    return install ?? null;
  },

  async connect(ctx, _slug, body) {
    const prepared = await prepareSlackConnect((body ?? {}) as SlackConnectBody);
    const summary = await saveSlackInstall({
      projectId: ctx.projectId,
      botToken: prepared.botToken,
      signingSecret: prepared.signingSecret,
      teamId: prepared.teamId,
      teamName: prepared.teamName,
      botUserId: prepared.botUserId,
    });
    await reconcileChannelConnectors(ctx.projectId);
    return summary;
  },

  async disconnect(ctx, _slug) {
    await deleteSlackInstall(ctx.projectId);
    // Tear down the auto-materialized Slack connector now that the install is gone.
    await reconcileChannelConnectors(ctx.projectId);
  },

  capabilities: {
    /** Server-side download proxy: fetch a Slack-hosted file with the bot
     * token (SSRF-guarded to *.slack.com) so the sandbox never holds it. */
    getFile: {
      method: 'get',
      access: 'member',
      async handler(ctx, input, _c) {
        const query = (input ?? {}) as { url?: string };
        const result = await downloadSlackFile(ctx.projectId, query.url ?? '');
        if (!result.ok) throw new ChannelError(result.status, { error: result.error });
        return new Response(result.body, {
          headers: { 'content-type': result.contentType },
        });
      },
    },

    /** Server-side upload proxy: the 3-step external upload, bot token
     * server-side. This is a SEND primitive, gated as write. */
    uploadFile: {
      method: 'post',
      access: 'write',
      async handler(ctx, input, _c) {
        const body = (input ?? {}) as {
          channel?: string;
          filename?: string;
          content_base64?: string;
          contentBase64?: string;
          comment?: string;
          thread_ts?: string;
          threadTs?: string;
        };
        const result = await uploadSlackFile(ctx.projectId, {
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
        if (!result.ok) throw new ChannelError(result.status, { error: result.error });
        return { ok: true, files: result.files };
      },
    },

    /** Bind a Slack thread the agent created out of band to its session, so a
     * later human reply in that thread routes back into this session. */
    bindThread: {
      method: 'post',
      access: 'session',
      async handler(ctx, input, _c) {
        const resolved = await resolveBindThreadTarget(ctx, (input ?? {}) as SlackBindThreadBody);
        await bindChatThread({
          projectId: ctx.projectId,
          workspaceId: resolved.workspaceId,
          threadId: resolved.threadTs,
          sessionId: resolved.sessionId,
        });
        return { ok: true, bound: true, channel: resolved.channel, thread_ts: resolved.threadTs };
      },
    },
  },
};
