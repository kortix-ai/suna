export interface SlackManifest {
  display_information: {
    name: string;
    description: string;
    background_color?: string;
  };
  features: {
    bot_user: { display_name: string; always_online: boolean };
    slash_commands: Array<{
      command: string;
      url: string;
      description: string;
      usage_hint?: string;
      should_escape?: boolean;
    }>;
    shortcuts: Array<{ name: string; type: string; callback_id: string; description: string }>;
  };
  oauth_config: {
    scopes: { bot: string[] };
  };
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
      request_url: string;
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

  // Keep this list in sync with slack-app-manifest.json and the
  // SLACK_OAUTH_SCOPES default in config.ts. 100% bot-token scopes — the
  // integration only ever uses the bot token, never a user token, so no
  // user scopes are requested. `search:read` is deliberately omitted because
  // search.messages is user-token only.
  const scopes = [
    'app_mentions:read',
    'assistant:write',
    'bookmarks:read',
    'bookmarks:write',
    'calls:read',
    'calls:write',
    'canvases:read',
    'canvases:write',
    'channels:history',
    'channels:join',
    'channels:manage',
    'channels:read',
    'chat:write',
    'chat:write.customize',
    'chat:write.public',
    'commands',
    'conversations.connect:manage',
    'conversations.connect:read',
    'conversations.connect:write',
    'dnd:read',
    'emoji:read',
    'files:read',
    'files:write',
    'groups:history',
    'groups:read',
    'groups:write',
    'im:history',
    'im:read',
    'im:write',
    'links.embed:write',
    'links:read',
    'links:write',
    'lists:read',
    'lists:write',
    'metadata.message:read',
    'mpim:history',
    'mpim:read',
    'mpim:write',
    'pins:read',
    'pins:write',
    'reactions:read',
    'reactions:write',
    'reminders:read',
    'reminders:write',
    'remote_files:read',
    'remote_files:share',
    'remote_files:write',
    'team.billing:read',
    'team.preferences:read',
    'team:read',
    'usergroups:read',
    'usergroups:write',
    'users.profile:read',
    'users:read',
    'users:read.email',
    'users:write',
    'workflow.steps:execute',
  ];

  return {
    display_information: {
      name: input.appName ?? 'Kortix',
      description: input.description ?? 'Your AI workforce, in Slack — @-mention an agent and it does the real work.',
      background_color: '#0a0a0a',
    },
    features: {
      bot_user: { display_name: input.botName ?? 'kortix', always_online: true },
      slash_commands: [
        {
          command: '/kortix',
          url: `${requestUrl}/commands`,
          description: 'Manage your Kortix project from Slack',
          usage_hint: '[projects | switch | agents | models | session | whoami | help]',
          should_escape: false,
        },
      ],
      shortcuts: [
        {
          name: 'Open in Kortix',
          type: 'message',
          callback_id: 'open_session',
          description: "Open this thread's Kortix session on the web",
        },
      ],
    },
    oauth_config: {
      scopes: { bot: scopes },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          'app_mention',
          'assistant_thread_started',
          'assistant_thread_context_changed',
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
      interactivity: {
        is_enabled: true,
        request_url: `${requestUrl}/interactivity`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function resolveBaseUrl(reqUrl: URL, override?: string): string {
  if (override) return stripTrailingSlash(override);
  const forwarded = reqUrl.hostname;
  const protocol = reqUrl.protocol.startsWith('https') ? 'https' : 'http';
  return `${protocol}://${forwarded}${reqUrl.port ? `:${reqUrl.port}` : ''}`;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, '');
}
