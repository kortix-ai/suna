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
  permissions: string[];
  validDomains: string[];
}

const BOT_COMMANDS = [
  { title: '/help', description: 'Show what Kortix can do' },
  { title: '/status', description: 'Show the effective project, agent and model' },
  { title: '/login', description: 'Connect your Kortix account' },
  { title: '/models', description: 'Pick the model for this conversation' },
  { title: '/agents', description: 'Pick the agent for this conversation' },
  { title: '/projects', description: 'List connected projects' },
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
  'Your AI workforce, in Teams — @-mention an agent and it does the real work.';

const LONG_DESCRIPTION =
  'Kortix brings a workforce of AI agents into Microsoft Teams. Add the bot to a chat or channel, @-mention it with a task, and an agent gets on it — working across your connected tools and replying right here as it goes, with live progress. Follow-ups stay in the same conversation. Managed by Kortix · https://kortix.com';

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
    version: '1.0.0',
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
    accentColor: '#0A0A0A',
    bots: [
      {
        botId: cfg.appId,
        scopes: ['personal', 'team', 'groupchat'],
        supportsFiles: true,
        isNotificationOnly: false,
        commandLists: [{ scopes: ['personal', 'team', 'groupchat'], commands: BOT_COMMANDS }],
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [hostOf(cfg.baseUrl)],
  };
}
