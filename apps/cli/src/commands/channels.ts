import { readFileSync } from 'node:fs';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix channels <subcommand> [options]

Manage the per-project Slack connection. Tokens are stored encrypted in
the project's secrets manager (\`project_secrets\`). At session spawn they
land in the sandbox as env vars, so the in-sandbox \`slack\` CLI can post
back to your workspace.

Subcommands:
  status                  Show the current Slack connection.
  connect                 Save bot token + signing secret to project_secrets.
                          Pass --bot-token / --signing-secret, set
                          SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET in env,
                          or use \`-\` to read from stdin.
  disconnect              Drop the project's Slack secrets.
  manifest                Print the Slack app manifest JSON (paste into
                          api.slack.com/apps → "From a manifest").

Global options:
  --project <id>          Operate on this project id (default: linked or
                          \$KORTIX_PROJECT_ID).
  --host <name>           Use this host instead of the linked / active one.
  -h, --help              Show this help.

Connect options:
  --bot-token <xoxb-…>    Bot User OAuth Token. Or env SLACK_BOT_TOKEN. Or \`-\` for stdin.
  --signing-secret <…>    Signing secret. Or env SLACK_SIGNING_SECRET. Or \`-\` for stdin.
`;

interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export async function runChannels(argv: string[]): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv.slice(0);

  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let botTokenFlag: string | undefined;
  let signingSecretFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    botTokenFlag = takeFlagValue(rest, ['--bot-token']);
    signingSecretFlag = takeFlagValue(rest, ['--signing-secret']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'status':
      return channelsStatus(ctxOpts);
    case 'connect':
      return channelsConnect(ctxOpts, botTokenFlag, signingSecretFlag);
    case 'disconnect':
    case 'remove':
    case 'rm':
      return channelsDisconnect(ctxOpts);
    case 'manifest':
      return channelsManifest(ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function channelsStatus(
  ctxOpts: { projectArg?: string; hostArg?: string },
): Promise<number> {
  const ctx = resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    const install = await ctx.client.get<SlackInstallation | null>(
      `/projects/${ctx.projectId}/channels/slack/installation`,
    );
    if (!install) {
      process.stdout.write(
        `${C.dim}slack${C.reset}  not connected\n` +
          `       Run ${C.cyan}kortix channels connect${C.reset} to wire one up.\n`,
      );
      return 0;
    }
    const name = install.workspaceName ?? install.workspaceId;
    const webhookUrl = `${ctx.client.apiBase.replace(/\/$/, '')}/v1/webhooks/slack/${ctx.projectId}`;
    process.stdout.write(
      `${status.ok('Slack')}  ${C.bold}${name}${C.reset}\n` +
        `         team       ${C.dim}${install.workspaceId}${C.reset}\n` +
        `         bot        ${C.dim}${install.botUserId ?? '—'}${C.reset}\n` +
        `         webhook    ${C.dim}${webhookUrl}${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function channelsConnect(
  ctxOpts: { projectArg?: string; hostArg?: string },
  botTokenFlag: string | undefined,
  signingSecretFlag: string | undefined,
): Promise<number> {
  const ctx = resolveProjectContext(ctxOpts);
  if (!ctx) return 1;

  const botToken = resolveSecret('bot token', botTokenFlag, 'SLACK_BOT_TOKEN');
  const signingSecret = resolveSecret(
    'signing secret',
    signingSecretFlag,
    'SLACK_SIGNING_SECRET',
  );
  if (botToken === null || signingSecret === null) return 2;
  if (!botToken.startsWith('xoxb-')) {
    process.stderr.write(`${status.err('Bot token must start with `xoxb-`.')}\n`);
    return 2;
  }

  let install: SlackInstallation;
  try {
    install = await ctx.client.post<SlackInstallation>(
      `/projects/${ctx.projectId}/channels/slack/connect`,
      { bot_token: botToken, signing_secret: signingSecret },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  const name = install.workspaceName ?? install.workspaceId;
  const webhookUrl = `${ctx.client.apiBase.replace(/\/$/, '')}/v1/webhooks/slack/${ctx.projectId}`;
  process.stdout.write(
    `${status.ok(`Connected to ${name}`)}\n` +
      `         team       ${C.dim}${install.workspaceId}${C.reset}\n` +
      `         bot        ${C.dim}${install.botUserId ?? '—'}${C.reset}\n` +
      `         webhook    ${C.dim}${webhookUrl}${C.reset}\n`,
  );
  return 0;
}

async function channelsDisconnect(
  ctxOpts: { projectArg?: string; hostArg?: string },
): Promise<number> {
  const ctx = resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/channels/slack/installation`);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok('Disconnected')} ${C.dim}— secrets removed${C.reset}\n`);
  return 0;
}

async function channelsManifest(
  ctxOpts: { projectArg?: string; hostArg?: string },
): Promise<number> {
  const ctx = resolveProjectContext(ctxOpts);
  if (!ctx) return 1;

  const baseUrl = ctx.client.apiBase.replace(/\/$/, '');
  const requestUrl = `${baseUrl}/v1/webhooks/slack/${ctx.projectId}`;

  const manifest = {
    display_information: {
      name: 'Kortix',
      description: 'Run a Kortix project from Slack',
      background_color: '#0a0a0a',
    },
    features: { bot_user: { display_name: 'kortix', always_online: true } },
    oauth_config: {
      scopes: {
        bot: [
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
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          'app_mention',
          'message.im',
          'message.channels',
          'message.groups',
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
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

function resolveSecret(label: string, flagValue: string | undefined, envName: string): string | null {
  let value = flagValue?.trim() ?? '';
  if (value === '-') {
    value = readFileSync(0, 'utf-8').trim();
  } else if (!value) {
    value = (process.env[envName] ?? '').trim();
  }
  if (!value) {
    process.stderr.write(
      `${status.err(`Missing ${label}. Pass --${label.replace(' ', '-')} or set ${envName}.`)}\n`,
    );
    return null;
  }
  return value;
}
