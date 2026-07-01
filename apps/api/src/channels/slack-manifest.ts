import type { Effect } from 'effect';
// ─────────────────────────────────────────────────────────────────────────────
// THE single source of truth for the Kortix Slack app manifest.
//
// There is ONE manifest implementation, `buildSlackManifest`. Everything else
// is a thin call into it with deployment-specific values:
//   • the canonical OAuth app (dev + prod)  → CANONICAL_DEV / CANONICAL_PROD,
//     whose generated output is committed as slack-app-manifest(.prod).json and
//     guarded against drift by a unit test (scripts/gen-slack-manifest.ts).
//   • per-project BYO apps                   → generateSlackManifest(), also
//     served at GET /v1/webhooks/slack/:projectId/manifest so the in-sandbox
//     agent CLI fetches it instead of rebuilding its own copy.
//
// Canonical and BYO apps are IDENTICAL except for the request URLs, the slash
// command name, the app/bot names, and whether the app uses Kortix's OAuth
// redirect. Those are config — never a second implementation.
// ─────────────────────────────────────────────────────────────────────────────

export interface SlackManifest {
  display_information: {
    name: string;
    description: string;
    long_description?: string;
    background_color?: string;
  };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    assistant_view: { assistant_description: string; suggested_prompts: string[] };
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
    redirect_urls?: string[];
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

// ── Shared, deployment-independent constants ─────────────────────────────────

// 100% bot-token scopes — the integration only ever uses the bot token, never a
// user token. `search:read` is deliberately omitted (search.messages is
// user-token only). This is THE scope list; config.ts derives the OAuth scope
// string from it, and the canonical + BYO manifests both embed it.
export const SLACK_BOT_SCOPES = [
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
] as const;

const BOT_EVENTS = [
  'app_mention',
  'app_home_opened',
  'assistant_thread_started',
  'assistant_thread_context_changed',
  'message.im',
  'message.channels',
  'message.groups',
  'message.mpim',
  'reaction_added',
  'reaction_removed',
  'member_joined_channel',
  'file_shared',
  'link_shared',
] as const;

const SHORTCUTS = [
  {
    name: 'Open in Kortix',
    type: 'message',
    callback_id: 'open_session',
    description: "Open this thread's Kortix session on the web",
  },
] as const;

const APP_HOME = {
  home_tab_enabled: true,
  messages_tab_enabled: true,
  messages_tab_read_only_enabled: false,
} as const;

const ASSISTANT_VIEW = {
  assistant_description:
    'Your AI workforce in Slack — give Kortix a task and an agent does the real work across your tools, then replies right here.',
  suggested_prompts: [] as string[],
} as const;

const SLASH_USAGE_HINT = '[projects | switch | agents | models | session | whoami | help]';

const SHORT_DESCRIPTION =
  'Your AI workforce, in Slack — @-mention an agent and it does the real work.';

const LONG_DESCRIPTION =
  'Kortix is the AI command center for your company — your agents, integrations, automations, and memory in one place, with a workforce of AI agents that does real work across your tools, around the clock. This app brings that workforce into Slack.\n\nInvite the bot to a channel, @-mention it with a task, and an agent gets on it: working across your connected tools and replying in the thread as it goes. Follow-ups stay in the same conversation — Kortix keeps the full context.\n\n*What it can do*\n• Research, search your tools, and summarize threads or documents\n• Pull data, analyze it, and drop reports, decks, and CSVs back into the thread\n• Draft replies, docs, and updates — then post them or hand them off\n• Run multi-step work across thousands of connected integrations\n• Kick off and check on automations that run on a schedule or a trigger\n• Read repos, edit files, and open PRs too — when that\'s the job\n\n*A few things teammates ask it*\n• `@Kortix pull yesterday\'s sign-ups, group them by source, and drop the CSV here`\n• `@Kortix summarize this thread and draft a reply to the customer`\n• `@Kortix build me a one-pager on our Q2 numbers`\n• `@Kortix what changed across our tools this week?`\n\nConnect a Kortix project once, then talk to Kortix like you\'d talk to anyone else on the team. No slash commands. No copy-paste. Just @-mention and reply.\n\n*AI Disclaimer*\nKortix uses AI to generate responses and perform tasks. While we strive for accuracy, AI-generated content may occasionally contain errors. Review important outputs before acting on them.\n\nManaged by Kortix · https://kortix.com';

// ── The ONE builder ───────────────────────────────────────────────────────────

export interface BuildManifestConfig {
  /** App display name (e.g. 'Kortix', 'KortixDev'). */
  appName: string;
  /** Bot user display name. */
  botName: string;
  /** Slash command (e.g. '/kortix', '/kortix-dev'). */
  command: string;
  /** Public base URL of the API (e.g. https://api.kortix.com). */
  baseUrl: string;
  /**
   * The webhook path this app posts to.
   *   • canonical OAuth app → '/v1/webhooks/slack'
   *   • per-project BYO app → '/v1/webhooks/slack/<projectId>'
   * Commands + interactivity hang off it as '<path>/commands' and
   * '<path>/interactivity'.
   */
  webhookPath: string;
  /** Canonical app installs via Kortix OAuth → add the redirect url. BYO apps are self-installed. */
  oauthRedirect?: boolean;
  /** Short tagline shown in the app directory. */
  description?: string;
  /** Long marketing description. Canonical apps set it; BYO apps usually omit it. */
  longDescription?: string;
  backgroundColor?: string;
}

export function buildSlackManifest(cfg: BuildManifestConfig): SlackManifest {
  const base = stripTrailingSlash(cfg.baseUrl);
  const webhook = `${base}${cfg.webhookPath}`;
  return {
    display_information: {
      name: cfg.appName,
      description: cfg.description ?? SHORT_DESCRIPTION,
      ...(cfg.longDescription ? { long_description: cfg.longDescription } : {}),
      background_color: cfg.backgroundColor ?? '#0a0a0a',
    },
    features: {
      app_home: { ...APP_HOME },
      assistant_view: { ...ASSISTANT_VIEW, suggested_prompts: [...ASSISTANT_VIEW.suggested_prompts] },
      bot_user: { display_name: cfg.botName, always_online: true },
      slash_commands: [
        {
          command: cfg.command,
          url: `${webhook}/commands`,
          description: 'Manage your Kortix project from Slack',
          usage_hint: SLASH_USAGE_HINT,
          should_escape: false,
        },
      ],
      shortcuts: SHORTCUTS.map((s) => ({ ...s })),
    },
    oauth_config: {
      ...(cfg.oauthRedirect ? { redirect_urls: [`${base}/v1/webhooks/slack/oauth/callback`] } : {}),
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: webhook,
        bot_events: [...BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
        request_url: `${webhook}/interactivity`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

// ── The canonical (dev/prod) configs — the committed JSON is generated from these.

export const CANONICAL_DEV: BuildManifestConfig = {
  appName: 'KortixDev',
  botName: 'KortixDev',
  command: '/kortix-dev',
  baseUrl: 'https://dev-api.kortix.com',
  webhookPath: '/v1/webhooks/slack',
  oauthRedirect: true,
  longDescription: LONG_DESCRIPTION,
};

export const CANONICAL_PROD: BuildManifestConfig = {
  appName: 'Kortix',
  botName: 'Kortix',
  command: '/kortix',
  baseUrl: 'https://api.kortix.com',
  webhookPath: '/v1/webhooks/slack',
  oauthRedirect: true,
  longDescription: LONG_DESCRIPTION,
};

// ── BYO per-project manifest ─────────────────────────────────────────────────

export interface GenerateManifestInput {
  baseUrl: string;
  projectId: string;
  appName?: string;
  botName?: string;
  command?: string;
  description?: string;
}

/** Per-project (BYO) manifest. Same implementation as canonical, scoped to the project. */
export function generateSlackManifest(input: GenerateManifestInput): SlackManifest {
  const appName = input.appName ?? 'Kortix';
  const botName = input.botName ?? 'kortix';
  return buildSlackManifest({
    appName,
    botName,
    command: normalizeSlashCommand(input.command) ?? defaultByoSlashCommand(appName, botName),
    baseUrl: input.baseUrl,
    webhookPath: `/v1/webhooks/slack/${input.projectId}`,
    oauthRedirect: false,
    description: input.description,
  });
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

export function defaultByoSlashCommand(appName: string, botName: string): string {
  const source = appName.trim().toLowerCase() === 'kortix'
    ? botName
    : appName;
  const slug = source
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
  return slug && slug !== 'kortix' ? `/${slug}` : '/kortix';
}

function normalizeSlashCommand(command?: string): string | null {
  const raw = command?.trim().toLowerCase();
  if (!raw) return null;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const slug = withSlash
    .slice(1)
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
  return slug ? `/${slug}` : null;
}
