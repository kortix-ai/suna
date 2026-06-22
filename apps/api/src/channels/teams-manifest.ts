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
  }>;
  permissions: string[];
  validDomains: string[];
}

export interface BuildTeamsManifestConfig {
  appId: string;
  baseUrl: string;
  appName?: string;
  botName?: string;
  description?: string;
  longDescription?: string;
}

const SHORT_DESCRIPTION = 'Your AI workforce, in Teams — @-mention an agent and it does the real work.';

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
  const botName = cfg.botName ?? 'Kortix';
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
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
      },
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [hostOf(cfg.baseUrl)],
  };
}
