import { config } from '../config';

export interface SlackManifest {
  display_information: {
    name: string;
    description: string;
    background_color?: string;
  };
  features: {
    bot_user: { display_name: string; always_online: boolean };
  };
  oauth_config: {
    scopes: { bot: string[] };
  };
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface GenerateManifestInput {
  baseUrl: string;
  projectId: string;
  appName?: string;
  botName?: string;
  description?: string;
}

export function generateSlackManifest(input: GenerateManifestInput): SlackManifest {
  const base = stripTrailingSlash(input.baseUrl);
  const requestUrl = `${base}/v1/webhooks/slack/${input.projectId}`;

  const scopes = [
    'app_mentions:read',
    'channels:history',
    'channels:read',
    'channels:join',
    'chat:write',
    'chat:write.public',
    'files:read',
    'files:write',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'mpim:history',
    'mpim:read',
    'reactions:read',
    'reactions:write',
    'users:read',
  ];

  return {
    display_information: {
      name: input.appName ?? 'Kortix',
      description: input.description ?? 'Your AI workforce, in Slack — @-mention an agent and it does the real work.',
      background_color: '#0a0a0a',
    },
    features: {
      bot_user: { display_name: input.botName ?? 'kortix', always_online: true },
    },
    oauth_config: {
      scopes: { bot: scopes },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          'app_mention',
          'message.channels',
          'message.groups',
          'message.im',
          'message.mpim',
          'reaction_added',
          'reaction_removed',
          'member_joined_channel',
          'file_shared',
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function resolveBaseUrl(reqUrl: URL, override?: string): string {
  if (override) return stripTrailingSlash(override);
  const dashboard = config.KORTIX_DASHBOARD_URL;
  if (dashboard) return stripTrailingSlash(dashboard).replace(/\/dashboard.*$/, '');
  const forwarded = reqUrl.hostname;
  const protocol = reqUrl.protocol.startsWith('https') ? 'https' : 'http';
  return `${protocol}://${forwarded}${reqUrl.port ? `:${reqUrl.port}` : ''}`;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, '');
}
