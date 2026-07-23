/**
 * Microsoft Teams connector provider descriptor. Ports the behavior of the
 * old `/channels/teams/{installation,mode,manifest,connect,file,file/upload}`
 * handlers onto the uniform ConnectorProviderDescriptor contract. Behavior —
 * including the `TEAMS_CHANNEL_ENABLED` server-wide gate and status codes —
 * is preserved exactly.
 */
import { config } from '../../config';
import { resolveBaseUrl } from '../slack-manifest';
import { teamsChannelEnabled } from '../teams-auth';
import { buildTeamsManifest } from '../teams-manifest';
import { teamsDeepLink, teamsMode } from '../teams-mode';
import { teamsOrgConsentUrl } from '../teams-oauth';
import { downloadTeamsFile, initiateTeamsUpload } from '../teams/file-proxy';
import {
  deleteTeamsInstall,
  loadTeamsAppIdForProject,
  loadTeamsInstall,
  saveTeamsInstall,
} from '../install-store';
import { reconcileChannelConnectors } from '../../executor/sync';
import { ChannelError, type ConnectorProviderDescriptor } from './descriptor';
import { TEAMS_DEFAULT_SLUG, type TeamsConnectBody, prepareTeamsConnect } from '../teams/connect';

/** Teams is gated by a server-wide config flag, not a per-project experimental feature. */
function isEnabled(_metadata: unknown): boolean {
  return teamsChannelEnabled();
}

/** Shared 404 for a disabled Teams channel — matches the old handlers' `Not found`. */
function assertEnabled(): void {
  if (!teamsChannelEnabled()) {
    throw new ChannelError(404, { error: 'Not found' });
  }
}

/** Public base URL override — only trusted when KORTIX_URL is an https origin. */
function teamsPublicBaseUrl(): string | undefined {
  return config.KORTIX_URL?.startsWith('https://') ? config.KORTIX_URL : undefined;
}

export const teamsDescriptor: ConnectorProviderDescriptor = {
  platform: 'teams',
  label: 'Microsoft Teams',
  reservedSlug: TEAMS_DEFAULT_SLUG,
  defaultSlug: TEAMS_DEFAULT_SLUG,
  direction: 'inbound',
  isEnabled,

  async getMode(ctx) {
    // No enablement gate here — the old GET /mode handler always answered,
    // with `teamsMode()` itself folding TEAMS_CHANNEL_ENABLED into `enabled`.
    const baseUrl = resolveBaseUrl(new URL(ctx.requestUrl), teamsPublicBaseUrl());
    const byoAppId = await loadTeamsAppIdForProject(ctx.projectId);
    const install = await loadTeamsInstall(ctx.projectId).catch(() => null);
    return {
      ...teamsMode(baseUrl, { projectId: ctx.projectId, byoAppId }),
      orgConsentUrl: byoAppId ? null : teamsOrgConsentUrl({ projectId: ctx.projectId, baseUrl }),
      orgInstalled: install?.orgInstalled ?? false,
      deepLinkUrl: install?.catalogAppId ? teamsDeepLink(install.catalogAppId) : null,
    };
  },

  async getInstallation(ctx, _slug) {
    // No enablement gate here either — the old GET /installation handler
    // returned whatever install exists (or null) regardless of the flag.
    return await loadTeamsInstall(ctx.projectId);
  },

  async connect(ctx, _slug, body) {
    assertEnabled();
    const prepared = prepareTeamsConnect((body ?? {}) as TeamsConnectBody);
    const summary = await saveTeamsInstall({
      projectId: ctx.projectId,
      tenantId: prepared.tenantId,
      teamName: prepared.teamName,
      appId: prepared.appId,
      appPassword: prepared.appPassword,
    });
    // Fire-and-forget, same as the old handler — the response doesn't wait on it.
    void reconcileChannelConnectors(ctx.projectId);
    return summary;
  },

  async disconnect(ctx, _slug) {
    await deleteTeamsInstall(ctx.projectId);
    void reconcileChannelConnectors(ctx.projectId);
  },

  capabilities: {
    /** GET the Teams app manifest — 409s when the server has no configured app. */
    manifest: {
      method: 'get',
      access: 'member',
      async handler(ctx, _input, _c) {
        const byoAppId = await loadTeamsAppIdForProject(ctx.projectId);
        const baseUrl = resolveBaseUrl(new URL(ctx.requestUrl), teamsPublicBaseUrl());
        const mode = teamsMode(baseUrl, { projectId: ctx.projectId, byoAppId });
        if (!mode.available || !mode.appId) {
          throw new ChannelError(409, { error: 'Teams is not configured on this server' });
        }
        return buildTeamsManifest({
          appId: mode.appId,
          baseUrl,
          appName: config.TEAMS_APP_NAME,
          botName: config.TEAMS_APP_NAME,
        });
      },
    },

    /** GET a SharePoint/Graph file the bot referenced — download proxy. */
    getFile: {
      method: 'get',
      access: 'member',
      async handler(ctx, input, _c) {
        const query = (input ?? {}) as Record<string, string | undefined>;
        const result = await downloadTeamsFile(ctx.projectId, query.url ?? '');
        if (!result.ok) throw new ChannelError(result.status, { error: result.error });
        return new Response(result.body, {
          status: 200,
          headers: { 'Content-Type': result.contentType },
        });
      },
    },

    /** POST a file-consent card to a Teams conversation (bot uploads to the user). */
    uploadFile: {
      method: 'post',
      access: 'member',
      async handler(ctx, input, _c) {
        assertEnabled();
        const body = (input ?? {}) as Record<string, unknown>;
        const result = await initiateTeamsUpload(ctx.projectId, {
          serviceUrl: String(body.service_url ?? body.serviceUrl ?? ''),
          conversationId: String(body.conversation_id ?? body.conversationId ?? ''),
          botId: typeof body.bot_id === 'string' ? body.bot_id : undefined,
          filename: String(body.filename ?? ''),
          contentBase64: String(body.content_base64 ?? body.contentBase64 ?? ''),
          description: typeof body.description === 'string' ? body.description : undefined,
        });
        if (!result.ok) throw new ChannelError(result.status, { error: result.error });
        return { ok: true, uploadId: result.uploadId };
      },
    },
  },
};
