import { readFileSync } from 'node:fs';
import { ApiError } from '../api/client.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix channels <subcommand> [options]

Connect this project to chat platforms — Slack, and optionally Telegram.

Subcommands:
  status                  Show the current channel connections (Slack + Telegram).
  connect                 Connect Slack. On Kortix Cloud (or any host with the
                          shared Slack app configured) this prints a one-click
                          "Add to Slack" install link — open it, pick the
                          workspace, Allow. Done: no app to create, no tokens.
                          Manual token mode (self-host without the shared app)
                          kicks in automatically, or force it with --manual.
                          With --platform telegram: connect a Telegram bot
                          (BYO token from @BotFather; Kortix registers the
                          webhook and keeps the token server-side).
  disconnect              Drop a channel connection (--platform picks which).
  pair                    Telegram only: mint a single-use pairing code (15 min).
                          The bot only answers allowlisted senders — send it
                          /start <code> (or open the printed t.me link) to put
                          yourself on the list. Repeat per person.
  manifest                Print the Slack app manifest JSON — MANUAL/self-host
                          setup only (paste into api.slack.com/apps → "From a
                          manifest"). The one-click install never needs this.

Global options:
  --platform <name>       slack (default) or telegram — Telegram is an
                          OPTIONAL channel; nothing requires it.
  --project <id>          Operate on this project id (default: linked or
                          \$KORTIX_PROJECT_ID).
  --host <name>           Use this host instead of the linked / active one.
  --json                  Machine-readable output (status/connect).
  -h, --help              Show this help.

Connect options (slack):
  --wait                  After printing the install link, poll until the
                          workspace is connected (Ctrl+C to stop).
  --timeout <sec>         Give up --wait after this many seconds (default 300).
  --manual                Skip the one-click flow; save a bot token + signing
                          secret instead.
  --bot-token <xoxb-…>    Bot User OAuth Token (implies --manual). Or env
                          SLACK_BOT_TOKEN. Or \`-\` for stdin.
  --signing-secret <…>    Signing secret (implies --manual). Or env
                          SLACK_SIGNING_SECRET. Or \`-\` for stdin.

Connect options (telegram):
  --bot-token <id:secret> Bot token from @BotFather (/newbot). Or env
                          TELEGRAM_BOT_TOKEN. Or \`-\` for stdin.
`;

interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

interface SlackMode {
  oauth_available: boolean;
  install_url: string | null;
}

interface TelegramPairing {
  code: string;
  expiresAt: string;
}

interface TelegramInstallation {
  botId: string;
  botUsername: string | null;
  installedAt: string;
  allowedUserIds?: string[];
  pairingRequired?: boolean;
  pairing?: TelegramPairing;
}

type ProjectCtx = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>;

export async function runChannels(argv: string[]): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv.slice(0);

  const json = takeFlagBool(rest, ['--json']);
  const manual = takeFlagBool(rest, ['--manual']);
  const wait = takeFlagBool(rest, ['--wait']);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let botTokenFlag: string | undefined;
  let signingSecretFlag: string | undefined;
  let timeoutFlag: string | undefined;
  let platformFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    botTokenFlag = takeFlagValue(rest, ['--bot-token']);
    signingSecretFlag = takeFlagValue(rest, ['--signing-secret']);
    timeoutFlag = takeFlagValue(rest, ['--timeout']);
    platformFlag = takeFlagValue(rest, ['--platform']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const platform = (platformFlag ?? 'slack').toLowerCase();
  if (platform !== 'slack' && platform !== 'telegram') {
    process.stderr.write(`${status.err(`unknown platform "${platform}" — slack or telegram`)}\n`);
    return 2;
  }
  const ctxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'status':
      return channelsStatus(ctxOpts, json, platform);
    case 'connect':
      if (platform === 'telegram') {
        return telegramConnect(ctxOpts, { json, botTokenFlag });
      }
      return channelsConnect(ctxOpts, {
        json,
        manual,
        wait,
        timeoutSec: timeoutFlag ? Number(timeoutFlag) : 300,
        botTokenFlag,
        signingSecretFlag,
      });
    case 'disconnect':
    case 'remove':
    case 'rm':
      if (platform === 'telegram') return telegramDisconnect(ctxOpts);
      return channelsDisconnect(ctxOpts);
    case 'pair':
      if (platform !== 'telegram') {
        process.stderr.write(
          `${status.err('pairing is a Telegram concept — use --platform telegram')}\n`,
        );
        return 2;
      }
      return telegramPair(ctxOpts, json);
    case 'manifest':
      if (platform === 'telegram') {
        process.stderr.write(
          `${status.err('Telegram needs no manifest')} — mint a bot with @BotFather (/newbot), then\n` +
            `${C.cyan}kortix channels connect --platform telegram --bot-token <id:secret>${C.reset}\n`,
        );
        return 2;
      }
      return channelsManifest(ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function channelsStatus(
  ctxOpts: { projectArg?: string; hostArg?: string },
  json: boolean,
  platform: 'slack' | 'telegram',
): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    if (platform === 'telegram') {
      const install = await ctx.client.get<TelegramInstallation | null>(
        `/projects/${ctx.projectId}/channels/telegram/installation`,
      );
      if (json) {
        emitJson({ connected: Boolean(install), installation: install ?? null });
        return 0;
      }
      writeTelegramStatusLine(install);
      return 0;
    }

    const install = await ctx.client.get<SlackInstallation | null>(
      `/projects/${ctx.projectId}/channels/slack/installation`,
    );
    // Telegram is optional — its status rides along informationally; a failure
    // to read it must never break the Slack status.
    const telegram = await ctx.client
      .get<TelegramInstallation | null>(`/projects/${ctx.projectId}/channels/telegram/installation`)
      .catch(() => null);
    if (json) {
      // Slack-shaped for compat; `telegram` is additive.
      emitJson({
        connected: Boolean(install),
        installation: install ?? null,
        telegram: { connected: Boolean(telegram), installation: telegram ?? null },
      });
      return 0;
    }
    if (!install) {
      process.stdout.write(
        `${C.dim}slack${C.reset}     not connected\n` +
          `          Run ${C.cyan}kortix channels connect${C.reset} — it prints a one-click "Add to Slack" link.\n`,
      );
    } else {
      printInstall(ctx, install, status.ok('Slack'));
    }
    writeTelegramStatusLine(telegram);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

function writeTelegramStatusLine(install: TelegramInstallation | null): void {
  if (!install) {
    process.stdout.write(
      `${C.dim}telegram${C.reset}  not connected ${C.dim}(optional)${C.reset}\n` +
        `          Run ${C.cyan}kortix channels connect --platform telegram --bot-token <id:secret>${C.reset} (token from @BotFather).\n`,
    );
    return;
  }
  const name = install.botUsername ? `@${install.botUsername}` : install.botId;
  process.stdout.write(
    `${status.ok('Telegram')}  ${C.bold}${name}${C.reset}\n` +
      `          bot id     ${C.dim}${install.botId}${C.reset}\n`,
  );
}

async function telegramConnect(
  ctxOpts: { projectArg?: string; hostArg?: string },
  opts: { json: boolean; botTokenFlag: string | undefined },
): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  const botToken = resolveSecret('bot token', opts.botTokenFlag, 'TELEGRAM_BOT_TOKEN');
  if (botToken === null) {
    process.stderr.write(
      `\nMint one with ${C.cyan}@BotFather${C.reset} (/newbot), then re-run\n` +
        `${C.cyan}kortix channels connect --platform telegram --bot-token <id:secret>${C.reset}\n`,
    );
    return 2;
  }
  if (!/^\d+:/.test(botToken)) {
    process.stderr.write(
      `${status.err('Bot token must look like <bot_id>:<secret> (from @BotFather).')}\n`,
    );
    return 2;
  }

  let install: TelegramInstallation;
  try {
    install = await ctx.client.post<TelegramInstallation>(
      `/projects/${ctx.projectId}/channels/telegram/connect`,
      { bot_token: botToken },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (opts.json) {
    emitJson({ connected: true, installation: install });
    return 0;
  }
  const name = install.botUsername ? `@${install.botUsername}` : install.botId;
  process.stdout.write(
    `${status.ok(`Connected ${name}`)} ${C.dim}— webhook registered, token stays server-side${C.reset}\n`,
  );
  if (install.pairing) {
    writePairingBlock(install.pairing, install.botUsername);
  } else {
    process.stdout.write(
      `          Message the bot to start a session; replies land in the chat.\n`,
    );
  }
  return 0;
}

function writePairingBlock(pairing: TelegramPairing, botUsername: string | null): void {
  const link = botUsername
    ? `https://t.me/${botUsername}?start=${encodeURIComponent(pairing.code)}`
    : null;
  process.stdout.write(
    `\n${C.bold}Pair yourself${C.reset} ${C.dim}— the bot only answers allowlisted senders${C.reset}\n` +
      `  Send the bot:  ${C.cyan}/start ${pairing.code}${C.reset}\n` +
      (link ? `  Or open:       ${C.cyan}${link}${C.reset}\n` : '') +
      `  ${C.dim}Single use, expires ${pairing.expiresAt}. Re-run \`kortix channels pair\` per person.${C.reset}\n`,
  );
}

async function telegramPair(
  ctxOpts: { projectArg?: string; hostArg?: string },
  json: boolean,
): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  let pairing: TelegramPairing;
  try {
    pairing = await ctx.client.post<TelegramPairing>(
      `/projects/${ctx.projectId}/channels/telegram/pairing-code`,
      {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  const install = await ctx.client
    .get<TelegramInstallation | null>(`/projects/${ctx.projectId}/channels/telegram/installation`)
    .catch(() => null);
  if (json) {
    emitJson({ pairing, botUsername: install?.botUsername ?? null });
    return 0;
  }
  writePairingBlock(pairing, install?.botUsername ?? null);
  return 0;
}

async function telegramDisconnect(ctxOpts: {
  projectArg?: string;
  hostArg?: string;
}): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/channels/telegram/installation`);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `${status.ok('Disconnected')} ${C.dim}— webhook removed, token deleted${C.reset}\n`,
  );
  return 0;
}

interface ConnectOpts {
  json: boolean;
  manual: boolean;
  wait: boolean;
  timeoutSec: number;
  botTokenFlag: string | undefined;
  signingSecretFlag: string | undefined;
}

async function channelsConnect(
  ctxOpts: { projectArg?: string; hostArg?: string },
  opts: ConnectOpts,
): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;

  // Explicit credentials always mean manual mode — never second-guess them.
  const wantsManual = opts.manual || Boolean(opts.botTokenFlag) || Boolean(opts.signingSecretFlag);
  if (wantsManual) {
    return connectManual(ctx, opts);
  }

  let mode: SlackMode = { oauth_available: false, install_url: null };
  try {
    mode = await ctx.client.get<SlackMode>(`/projects/${ctx.projectId}/channels/slack/mode`);
  } catch (err) {
    // A host too old to serve /mode still supports manual connect.
    if (!(err instanceof ApiError && err.status === 404)) return surfaceApiError(err);
  }

  if (!mode.oauth_available || !mode.install_url) {
    process.stdout.write(
      `${C.dim}One-click install isn't configured on this host (no shared Slack app) — manual setup:${C.reset}\n`,
    );
    return connectManual(ctx, opts);
  }

  let existing: SlackInstallation | null = null;
  try {
    existing = await ctx.client.get<SlackInstallation | null>(
      `/projects/${ctx.projectId}/channels/slack/installation`,
    );
  } catch {
    // Non-fatal: fall through and offer the install link anyway.
  }

  if (opts.json) {
    emitJson({
      connected: Boolean(existing),
      installation: existing ?? null,
      install_url: mode.install_url,
      note: existing
        ? 'Already connected. Opening install_url again re-installs or switches the workspace.'
        : 'Open install_url in a browser: pick the workspace, click Allow, done. Link is valid ~10 minutes.',
    });
    if (!opts.wait || existing) return 0;
  } else if (existing) {
    printInstall(ctx, existing, status.ok('Already connected'));
    process.stdout.write(
      `\n  To reinstall or switch workspaces, open:\n` +
        `  ${C.cyan}${mode.install_url}${C.reset}\n` +
        `  ${C.dim}(or run \`kortix channels disconnect\` first)${C.reset}\n`,
    );
    return 0;
  } else {
    process.stdout.write(
      `\n  ${C.bold}Add to Slack — one click:${C.reset}\n\n` +
        `  ${C.cyan}${mode.install_url}${C.reset}\n\n` +
        `  Open the link, pick your workspace, click ${C.bold}Allow${C.reset} — that's the whole setup.\n` +
        `  ${C.dim}No Slack app to create, no manifest, no tokens. Link valid ~10 minutes.${C.reset}\n` +
        `  Confirm after installing with ${C.cyan}kortix channels status${C.reset}.\n\n`,
    );
  }

  if (!opts.wait) return 0;
  return waitForInstall(ctx, opts.timeoutSec, opts.json);
}

async function waitForInstall(ctx: ProjectCtx, timeoutSec: number, json: boolean): Promise<number> {
  const deadline = Date.now() + timeoutSec * 1000;
  const intervalMs = 4000;
  if (!json) {
    process.stdout.write(`  ${C.dim}Waiting for the install… (Ctrl+C to stop)${C.reset}\n`);
  }
  for (;;) {
    let install: SlackInstallation | null = null;
    try {
      install = await ctx.client.get<SlackInstallation | null>(
        `/projects/${ctx.projectId}/channels/slack/installation`,
      );
    } catch {
      // Transient poll errors are fine; keep waiting until the deadline.
    }
    if (install) {
      if (json) {
        emitJson({ connected: true, installation: install });
      } else {
        printInstall(
          ctx,
          install,
          status.ok(`Connected to ${install.workspaceName ?? install.workspaceId}`),
        );
      }
      return 0;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `${status.err(`Still not connected after ${timeoutSec}s.`)} The link stays usable — ` +
          `check later with ${C.cyan}kortix channels status${C.reset}.\n`,
      );
      return 1;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function connectManual(ctx: ProjectCtx, opts: ConnectOpts): Promise<number> {
  const botToken = resolveSecret('bot token', opts.botTokenFlag, 'SLACK_BOT_TOKEN');
  const signingSecret = resolveSecret(
    'signing secret',
    opts.signingSecretFlag,
    'SLACK_SIGNING_SECRET',
  );
  if (botToken === null || signingSecret === null) {
    process.stderr.write(
      `\nManual setup: create the app with ${C.cyan}kortix channels manifest${C.reset} ` +
        `(api.slack.com/apps → "From a manifest"), install it to the workspace, then re-run\n` +
        `${C.cyan}kortix channels connect --bot-token xoxb-… --signing-secret …${C.reset}\n`,
    );
    return 2;
  }
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

  if (opts.json) {
    emitJson({ connected: true, installation: install });
    return 0;
  }
  printInstall(
    ctx,
    install,
    status.ok(`Connected to ${install.workspaceName ?? install.workspaceId}`),
  );
  return 0;
}

function printInstall(ctx: ProjectCtx, install: SlackInstallation, headline: string): void {
  const name = install.workspaceName ?? install.workspaceId;
  const webhookUrl = `${ctx.client.apiBase.replace(/\/$/, '')}/v1/webhooks/slack/${ctx.projectId}`;
  process.stdout.write(
    `${headline}  ${C.bold}${name}${C.reset}\n` +
      `         team       ${C.dim}${install.workspaceId}${C.reset}\n` +
      `         bot        ${C.dim}${install.botUserId ?? '—'}${C.reset}\n` +
      `         webhook    ${C.dim}${webhookUrl}${C.reset}\n`,
  );
}

async function channelsDisconnect(ctxOpts: {
  projectArg?: string;
  hostArg?: string;
}): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/channels/slack/installation`);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok('Disconnected')} ${C.dim}— secrets removed${C.reset}\n`);
  return 0;
}

async function channelsManifest(ctxOpts: {
  projectArg?: string;
  hostArg?: string;
}): Promise<number> {
  const ctx = await resolveProjectContext(ctxOpts);
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

function resolveSecret(
  label: string,
  flagValue: string | undefined,
  envName: string,
): string | null {
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
