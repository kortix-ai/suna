import { createHmac, timingSafeEqual } from 'node:crypto';
import { Chat, type StateAdapter } from 'chat';
import { createSlackAdapter, type SlackAdapterConfig, type SlackInstallation } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { PostgresStateAdapter } from '@chat-adapter/state-pg';
import { config } from '../config';
import {
  findProjectForWorkspace,
  loadSlackBotUserIdForProject,
  loadSlackSigningSecretForProject,
  loadSlackTeamNameForProject,
  loadSlackTokenForProject,
} from './install-store';
import { resolveChannelsMode, type ChannelsModeReport } from './mode';
import { registerMentionHandler } from './handlers/mention';
import { registerDmHandler } from './handlers/dm';
import { registerActionHandler } from './handlers/action';
import { registerReplyHandler } from './handlers/reply';

let cached: Chat | null = null;
let cachedReport: ChannelsModeReport | null = null;

export function getChannelsBot(): Chat | null {
  if (cached) return cached;
  const report = (cachedReport = resolveChannelsMode());
  if (report.mode === 'off') return null;

  const slackConfig: SlackAdapterConfig = {
    webhookVerifier: makeSlackWebhookVerifier(),
    installationProvider: {
      getInstallation: async (installationId): Promise<SlackInstallation | null> => {
        const projectId = await findProjectForWorkspace(installationId);
        if (!projectId) return null;
        const botToken = await loadSlackTokenForProject(projectId);
        if (!botToken) return null;
        const [botUserId, teamName] = await Promise.all([
          loadSlackBotUserIdForProject(projectId),
          loadSlackTeamNameForProject(projectId),
        ]);
        return {
          botToken,
          botUserId: botUserId ?? undefined,
          teamName: teamName ?? undefined,
        };
      },
    },
  };
  if (report.multiReady) {
    slackConfig.clientId = config.SLACK_CLIENT_ID;
    slackConfig.clientSecret = config.SLACK_CLIENT_SECRET;
  }

  const bot = new Chat({
    userName: 'kortix',
    adapters: { slack: createSlackAdapter(slackConfig) },
    state: buildState(),
    dedupeTtlMs: 600_000,
    logger: 'info',
  });

  registerMentionHandler(bot);
  registerDmHandler(bot);
  registerActionHandler(bot);
  registerReplyHandler(bot);

  cached = bot;
  return bot;
}

export function getChannelsModeReport(): ChannelsModeReport {
  if (cachedReport) return cachedReport;
  return resolveChannelsMode();
}

export function isChannelsConfigured(): boolean {
  return getChannelsModeReport().mode !== 'off';
}

export function isMultiTenantEnabled(): boolean {
  return getChannelsModeReport().multiReady;
}

function buildState(): StateAdapter {
  if (config.DATABASE_URL) {
    try {
      return new PostgresStateAdapter({ url: config.DATABASE_URL, keyPrefix: 'kortix-channels' });
    } catch (err) {
      console.warn('[channels] Postgres state adapter failed, falling back to memory:', err);
    }
  }
  return createMemoryState();
}

const SLACK_SIG_MAX_AGE_SECONDS = 5 * 60;

function makeSlackWebhookVerifier() {
  return async (request: Request, body: string): Promise<boolean | string> => {
    const timestamp = request.headers.get('x-slack-request-timestamp');
    const signature = request.headers.get('x-slack-signature');
    if (!timestamp || !signature) return false;
    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(skew) || skew > SLACK_SIG_MAX_AGE_SECONDS) return false;

    const teamId = extractSlackTeamId(body);
    let secret: string | null = null;
    if (teamId) {
      const projectId = await findProjectForWorkspace(teamId);
      if (projectId) secret = await loadSlackSigningSecretForProject(projectId);
    }
    if (!secret) return false;

    const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };
}

function extractSlackTeamId(rawBody: string): string | null {
  if (!rawBody) return null;
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (typeof parsed.team_id === 'string') return parsed.team_id;
    if (parsed.team && typeof parsed.team === 'object') {
      const id = (parsed.team as Record<string, unknown>).id;
      if (typeof id === 'string') return id;
    }
  } catch {
    const params = new URLSearchParams(rawBody);
    const payload = params.get('payload');
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed.team && typeof parsed.team === 'object') {
        const id = (parsed.team as Record<string, unknown>).id;
        if (typeof id === 'string') return id;
      }
    } catch {
      return null;
    }
  }
  return null;
}
