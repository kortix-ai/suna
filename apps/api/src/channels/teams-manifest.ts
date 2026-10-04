export interface TeamsManifest {
  $schema: string;
  manifestVersion: string;
  version: string;
  id: string;
  developer: {
    name: string;
    websiteUrl: string;
    privacyUrl: string;
    termsOfUseUrl: string;
  };
  name: { short: string; full: string };
  description: { short: string; full: string };
  icons: { color: string; outline: string };
  accentColor: string;
  bots: Array<{
    botId: string;
    scopes: string[];
    supportsFiles: boolean;
    isNotificationOnly: boolean;
    commandLists?: Array<{
      scopes: string[];
      commands: Array<{ title: string; description: string }>;
    }>;
  }>;
  composeExtensions?: Array<{
    botId: string;
    commands: Array<{
      id: string;
      type: 'action';
      title: string;
      description: string;
      context: Array<'message' | 'compose' | 'commandBox'>;
      fetchTask: boolean;
    }>;
  }>;
  permissions: string[];
  validDomains: string[];
  webApplicationInfo: { id: string; resource: string };
  authorization: {
    permissions: { resourceSpecific: Array<{ name: string; type: 'Application' | 'Delegated' }> };
  };
}

/**
 * Bump on every manifest change, text included. Graph refuses an app-definition
 * update that does not raise the version, so an unbumped change never reaches
 * a tenant that already has the app (1.6.1: the descriptions and accent color
 * changed under 1.6.0). The Channels page offers the update to every catalog
 * on an older version; a team owner still accepts a new permission or message
 * action in each team. `unit-teams-manifest.test.ts` fails until you bump.
 */
export const TEAMS_MANIFEST_VERSION = '1.6.2';

/**
 * Resource-specific consent (RSC). These let the bot receive every message in
 * a conversation it is installed in — not only @-mentions — so a reply in a
 * thread the bot owns continues the session without re-mentioning it, which is
 * how Slack threads already behave. Dispatch still ignores un-mentioned
 * messages outside such threads (teams/dispatch.ts), so the bot never answers
 * every line typed in a channel it was added to.
 *
 * - `ChannelMessage.Read.Group` — team channels.
 * - `ChatMessage.Read.Chat` — group chats. Without it Teams delivers only
 *   @-mentions there, so every reply in a group chat needed one.
 *
 * Adding a permission here needs a Teams admin to RE-consent when the app is
 * (re-)added to a team or chat — bump TEAMS_MANIFEST_VERSION with it.
 */
export const TEAMS_RSC_PERMISSIONS = [
  { name: 'ChannelMessage.Read.Group', type: 'Application' as const },
  { name: 'ChatMessage.Read.Chat', type: 'Application' as const },
];

const BOT_COMMANDS = [
  { title: '/help', description: 'Show what Kortix can do' },
  { title: '/status', description: 'Show and change the project, agent and model' },
  { title: '/sessions', description: 'Your recent sessions started from Teams' },
  { title: '/login', description: 'Connect your Kortix account' },
  { title: '/models', description: 'Pick the model for this conversation' },
  { title: '/agents', description: 'Pick the agent for this conversation' },
  { title: '/projects', description: 'List connected projects' },
  { title: '/stop', description: 'Stop the run in progress here' },
  { title: '/new', description: 'Start a new session in this chat' },
  { title: '/policy', description: 'Who may join sessions started here' },
];

export interface BuildTeamsManifestConfig {
  appId: string;
  baseUrl: string;
  appName?: string;
  botName?: string;
  description?: string;
  longDescription?: string;
}

const SHORT_DESCRIPTION =
  'Open-source AI Operating System — start a session from any Teams chat.';

const LONG_DESCRIPTION =
  'Kortix is an open-source AI Operating System — your agents, skills, company memory, and connectors in one git repo you own. This app starts Kortix sessions from Microsoft Teams. Add the bot to a chat or channel, @-mention it with a task, and an agent gets on it — using your connected tools and replying right here as it goes, with live progress. Follow-ups stay in the same session. Managed by Kortix · https://kortix.com';

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

export function buildTeamsManifest(cfg: BuildTeamsManifestConfig): TeamsManifest {
  const appName = cfg.appName ?? 'Kortix';
  return {
    $schema:
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    version: TEAMS_MANIFEST_VERSION,
    id: cfg.appId,
    developer: {
      name: 'Kortix',
      websiteUrl: 'https://kortix.com',
      privacyUrl: 'https://kortix.com/privacy',
      termsOfUseUrl: 'https://kortix.com/terms',
    },
    name: { short: appName, full: appName },
    description: {
      short: cfg.description ?? SHORT_DESCRIPTION,
      full: cfg.longDescription ?? LONG_DESCRIPTION,
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#0b0b0b',
    bots: [
      {
        botId: cfg.appId,
        scopes: ['personal', 'team', 'groupchat'],
        supportsFiles: true,
        isNotificationOnly: false,
        commandLists: [{ scopes: ['personal', 'team', 'groupchat'], commands: BOT_COMMANDS }],
      },
    ],
    // "Open in Kortix" on a message's ⋯ menu, as Slack's message shortcut
    // (teams/message-action.ts).
    composeExtensions: [
      {
        botId: cfg.appId,
        commands: [
          {
            id: 'openInKortix',
            type: 'action',
            title: 'Open in Kortix',
            description: "Open this conversation's Kortix session",
            context: ['message'],
            fetchTask: true,
          },
        ],
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [hostOf(cfg.baseUrl)],
    // RSC permissions hang off webApplicationInfo; `resource` is required by
    // the schema and is a placeholder for RSC-only apps.
    webApplicationInfo: { id: cfg.appId, resource: 'https://RscBasedStoreApp' },
    authorization: { permissions: { resourceSpecific: TEAMS_RSC_PERMISSIONS } },
  };
}
