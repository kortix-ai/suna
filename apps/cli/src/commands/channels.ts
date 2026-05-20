import { readFileSync } from 'node:fs';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix channels <subcommand> [options]

Manage the per-project Slack connection. Tokens are stored encrypted in
the project's secrets manager — the same envelope every other secret
uses. The bot listens in any channel of the connected workspace it's
been invited to.

Subcommands:
  status                  Show the current Slack connection for this project (default).
  connect                 Save bot token + signing secret to project_secrets.
                          Both required; either pass --bot-token / --signing-secret
                          or set SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET env vars.
                          \`-\` reads the value from stdin.
  disconnect              Drop the project's Slack secrets.
  manifest                Print the Slack app manifest JSON (for "From a manifest"
                          flow at api.slack.com/apps).

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

interface ChannelSpec {
  platform: 'slack';
  enabled: boolean;
  agent: string | null;
  promptPrefix: string | null;
  events: string[];
}

interface ChannelsList {
  specs: ChannelSpec[];
  errors: { platform: string; path: string; error: string }[];
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
    const [install, list] = await Promise.all([
      ctx.client.get<SlackInstallation | null>(
        `/projects/${ctx.projectId}/channels/slack/installation`,
      ),
      ctx.client.get<ChannelsList>(`/projects/${ctx.projectId}/channels`),
    ]);
    const spec = list.specs.find((s) => s.platform === 'slack');
    if (!install) {
      process.stdout.write(
        `${C.dim}slack${C.reset}  not connected\n` +
          `       Run ${C.cyan}kortix channels connect${C.reset} to wire one up.\n`,
      );
      return 0;
    }
    const name = install.workspaceName ?? install.workspaceId;
    process.stdout.write(
      `${status.ok('Slack')}  ${C.bold}${name}${C.reset}\n` +
        `         team       ${C.dim}${install.workspaceId}${C.reset}\n` +
        `         bot        ${C.dim}${install.botUserId ?? '—'}${C.reset}\n` +
        `         manifest   ${manifestStatusLine(spec)}\n`,
    );
    if (spec) {
      if (spec.agent) {
        process.stdout.write(`         agent      ${C.dim}${spec.agent}${C.reset}\n`);
      }
      if (spec.events?.length) {
        process.stdout.write(`         events     ${C.dim}${spec.events.join(', ')}${C.reset}\n`);
      }
    }
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

function manifestStatusLine(spec: ChannelSpec | undefined): string {
  if (!spec) {
    return `${C.yellow}missing${C.reset} ${C.dim}— no [[channels]] entry in kortix.toml${C.reset}`;
  }
  if (!spec.enabled) {
    return `${C.yellow}disabled${C.reset} ${C.dim}— [[channels]] enabled = false${C.reset}`;
  }
  return `${C.green}enabled${C.reset}`;
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

  // Idempotent commit of `[[channels]] platform = "slack"` to kortix.toml so
  // the next binding sweep can route Slack events to this project. Without
  // this, the secrets are saved but the bot still does nothing.
  try {
    await ctx.client.post<unknown>(`/projects/${ctx.projectId}/channels`, {
      platform: 'slack',
    });
  } catch (err) {
    const name = install.workspaceName ?? install.workspaceId;
    process.stdout.write(
      `${status.ok(`Connected to ${name}`)} ${C.dim}(secrets saved)${C.reset}\n`,
    );
    process.stderr.write(
      `${status.warn('Could not commit [[channels]] to kortix.toml — add it manually:')}\n` +
        `\n  [[channels]]\n  platform = "slack"\n\n`,
    );
    return surfaceApiError(err);
  }

  const name = install.workspaceName ?? install.workspaceId;
  process.stdout.write(
    `${status.ok(`Connected to ${name}`)}\n` +
      `         team       ${C.dim}${install.workspaceId}${C.reset}\n` +
      `         bot        ${C.dim}${install.botUserId ?? '—'}${C.reset}\n` +
      `         manifest   ${C.green}enabled${C.reset} ${C.dim}— [[channels]] committed to kortix.toml${C.reset}\n`,
  );
  return 0;
}

async function channelsDisconnect(
  ctxOpts: { projectArg?: string; hostArg?: string },
): Promise<number> {
  const ctx = resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  // Drop secrets first. If that succeeds but the manifest commit fails, the
  // user is still effectively disconnected (no creds = no events).
  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/channels/slack/installation`);
  } catch (err) {
    return surfaceApiError(err);
  }
  let manifestRemoved = true;
  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/channels/slack`);
  } catch {
    manifestRemoved = false;
  }
  process.stdout.write(
    `${status.ok('Disconnected')}\n` +
      `         secrets    ${C.dim}removed${C.reset}\n` +
      `         manifest   ${
        manifestRemoved
          ? `${C.dim}[[channels]] entry removed${C.reset}`
          : `${C.yellow}still present${C.reset} ${C.dim}— remove manually if you don't want it${C.reset}`
      }\n`,
  );
  return 0;
}

async function channelsManifest(
  ctxOpts: { projectArg?: string; hostArg?: string },
): Promise<number> {
  const ctx = resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    const manifest = await ctx.client.get<unknown>('/webhooks/chat/slack/manifest');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

function resolveSecret(label: string, flagValue: string | undefined, envName: string): string | null {
  let value = flagValue?.trim() ?? '';
  if (value === '-') {
    value = readStdin().trim();
  }
  if (!value) {
    const env = process.env[envName];
    if (env && env.trim()) value = env.trim();
  }
  if (!value) {
    process.stderr.write(
      `${status.err(`${label} is required`)} — pass ${C.cyan}--${label.replace(' ', '-')}${C.reset} or set ${C.cyan}${envName}${C.reset}.\n`,
    );
    return null;
  }
  return value;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
