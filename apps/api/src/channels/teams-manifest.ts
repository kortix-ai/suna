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
  webApplicationInfo: { id: string; resource: string };
  authorization: {
    permissions: { resourceSpecific: Array<{ name: string; type: 'Application' | 'Delegated' }> };
  };
}

/**
 * Bump when the manifest changes shape. The org-catalog publish upgrades an
 * existing app only when this differs from what the catalog holds, and a Teams
 * admin has to re-consent to new resource-specific permissions on the team.
 */
export const TEAMS_MANIFEST_VERSION = '1.2.0';

/**
 * Resource-specific consent (RSC). `ChannelMessage.Read.Group` lets the bot
 * receive every message in the channels of a team it is installed in — not
 * only @-mentions — so a reply in a thread the bot owns continues the
 * session without re-mentioning it. Dispatch still ignores un-mentioned
 * messages outside such threads (teams/dispatch.ts).
 */
export const TEAMS_RSC_PERMISSIONS = [
  { name: 'ChannelMessage.Read.Group', type: 'Application' as const },
];

const BOT_COMMANDS = [
  { title: '/help', description: 'Show what Kortix can do' },
  { title: '/status', description: 'Show the effective project, agent and model' },
  { title: '/login', description: 'Connect your Kortix account' },
  { title: '/models', description: 'Pick the model for this conversation' },
  { title: '/agents', description: 'Pick the agent for this conversation' },
  { title: '/projects', description: 'List connected projects' },
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
    // RSC permissions hang off webApplicationInfo; `resource` is required by
    // the schema and is a placeholder for RSC-only apps.
    webApplicationInfo: { id: cfg.appId, resource: 'https://RscBasedStoreApp' },
    authorization: { permissions: { resourceSpecific: TEAMS_RSC_PERMISSIONS } },
  };
}
