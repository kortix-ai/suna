import { config } from '../config';
import { resolveChannelsMode } from './mode';

export interface SlackManifest {
  display_information: {
    name: string;
    description: string;
    background_color?: string;
  };
  features: {
    bot_user: { display_name: string; always_online: boolean };
    slash_commands: Array<{ command: string; url: string; description: string; usage_hint?: string }>;
  };
  oauth_config: {
    redirect_urls?: string[];
    scopes: { bot: string[] };
  };
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    interactivity: { is_enabled: boolean; request_url: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface GenerateManifestInput {
  baseUrl: string;
  appName?: string;
  botName?: string;
  description?: string;
  includeOauth?: boolean;
  slashCommands?: Array<{ name: string; description: string; usage_hint?: string }>;
}

const DEFAULT_SLASH = [
  { name: 'plan', description: 'Draft a plan from the bound Kortix project', usage_hint: '<what to plan>' },
  { name: 'review', description: 'Review an open PR', usage_hint: '<pr-url>' },
];

export function generateSlackManifest(input: GenerateManifestInput): SlackManifest {
  const base = stripTrailingSlash(input.baseUrl);
  const eventUrl = `${base}/v1/webhooks/chat/slack`;
  const oauthRedirect = `${base}/v1/webhooks/chat/slack/oauth/callback`;
  const slashList = (input.slashCommands ?? DEFAULT_SLASH).map((c) => ({
    command: c.name.startsWith('/') ? c.name : `/${c.name}`,
    url: eventUrl,
    description: c.description,
    usage_hint: c.usage_hint,
  }));

  const scopes = [
    'app_mentions:read',
    'chat:write',
    'chat:write.public',
    'commands',
    'im:history',
    'im:read',
    'im:write',
    'channels:read',
    'groups:read',
    'users:read',
  ];

  const manifest: SlackManifest = {
    display_information: {
      name: input.appName ?? 'Kortix',
      description: input.description ?? 'Run Kortix project sessions from Slack',
      background_color: '#0a0a0a',
    },
    features: {
      bot_user: { display_name: input.botName ?? 'kortix', always_online: true },
      slash_commands: slashList,
    },
    oauth_config: {
      scopes: { bot: scopes },
    },
    settings: {
      event_subscriptions: {
        request_url: eventUrl,
        bot_events: [
          'app_mention',
          'message.channels',
          'message.groups',
          'message.im',
          'message.mpim',
        ],
      },
      interactivity: { is_enabled: true, request_url: eventUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  if (input.includeOauth) {
    manifest.oauth_config.redirect_urls = [oauthRedirect];
  }
  return manifest;
}

export function resolveBaseUrl(reqUrl: URL, override?: string): string {
  if (override) return stripTrailingSlash(override);
  const dashboard = config.KORTIX_DASHBOARD_URL;
  if (dashboard) return stripTrailingSlash(dashboard).replace(/\/dashboard.*$/, '');
  const forwarded = reqUrl.hostname;
  const protocol = reqUrl.protocol.startsWith('https') ? 'https' : 'http';
  return `${protocol}://${forwarded}${reqUrl.port ? `:${reqUrl.port}` : ''}`;
}

export function shouldIncludeOauthInManifest(): boolean {
  return resolveChannelsMode().multiReady;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, '');
}
