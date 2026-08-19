import '../node-ws-polyfill';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

import { TunnelAgent } from './agent';
import { printStartupBanner } from './banner';
import { createEnabledCapabilityRegistry } from './capabilities/enabled-registry';
import { loadConfig, type TunnelConfig } from './config';
import { CONFIG_FILE, clearSavedCredentials, saveCredentials } from './credential-store';
import { probeCredentials } from './credential-probe';
import {
  InvalidDeviceAuthResponseError,
  awaitDeviceAuthorization,
  openBrowser,
  requestDeviceAuthorization,
} from './device-auth';
import { collapseRepeatedLines, isShellStartupNoise } from './log-format';
import { anyFlag, isInteractiveTerminal, isTruthyFlag, promptYesNo } from './prompts';
import {
  DEFAULT_INSTALL_BACKGROUND_SERVICE,
  TERMINAL_SERVICE_EXIT_CODE,
  getServicePaths,
  getServiceStatus,
  rotateServiceLogs,
  serviceLogFiles,
} from './service';
import {
  SERVICE_ACTIONS,
  type ServiceAction,
  acquireTunnelLease,
  describeService,
  renderServiceAction,
} from './service-control';
import { blankLine, c, clearScreen, field, glyph, stripAnsi } from './terminal';
import { agentTunnelVersion } from './version';

const ALL_CAPABILITIES = ['filesystem', 'shell', 'desktop'] as const;
const BACKGROUND_FLAGS = ['daemon', 'service', 'background', 'always-online'] as const;
const FOREGROUND_FLAGS = ['foreground', 'no-daemon', 'no-service', 'no-background'] as const;
const DEFAULT_LOG_LINES = 60;

type Flags = Record<string, string>;

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    flags[arg.slice(2)] = next && !next.startsWith('--') ? argv[++i] : 'true';
  }
  return { command: argv[2] || 'help', flags };
}

function fail(message: string): never {
  console.error(`  ${glyph.bad} ${message}`);
  process.exit(1);
}

function shortenHomePath(path: string): string {
  const home = process.env.HOME ?? '';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// ── running the agent ────────────────────────────────────────────────────────

function startAgent(config: TunnelConfig, options: { service?: boolean } = {}): void {
  const registry = createEnabledCapabilityRegistry(config);
  if (config.enabledCapabilities?.includes('desktop') && !registry.has('desktop')) {
    console.error(
      '[agent-tunnel] Computer Use is approved but unavailable: install the trusted cua-driver locally, then restart Agent Tunnel.',
    );
  }

  if (options.service) {
    console.log(`[agent-tunnel] service starting: ${config.tunnelId} -> ${config.apiUrl}`);
  } else {
    clearScreen();
    void printStartupBanner({
      tunnelId: config.tunnelId,
      apiUrl: config.apiUrl,
      capabilities: registry.getCapabilityNames(),
      version: agentTunnelVersion(),
    });
  }

  const agent = new TunnelAgent(config, registry, {
    onTerminalClose: ({ reason }) => {
      if (!options.service) return;
      // Staying alive would leave a supervised process connected to nothing that
      // the supervisor never restarts. Exit cleanly so the service stops.
      console.log(`[agent-tunnel] stopping service: ${reason}`);
      process.exit(TERMINAL_SERVICE_EXIT_CODE);
    },
  });
  agent.connect();

  const shutdown = () => {
    if (!options.service) console.log(`\n${c.dim}  Shutting down…${c.reset}`);
    agent.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── pairing ──────────────────────────────────────────────────────────────────

async function chooseBackgroundMode(flags: Flags): Promise<boolean> {
  if (anyFlag(flags, BACKGROUND_FLAGS)) return true;
  if (anyFlag(flags, FOREGROUND_FLAGS)) return false;
  if (!isInteractiveTerminal()) return false;

  blankLine();
  console.log(`  ${glyph.warn} ${c.bold}Security note${c.reset}`);
  console.log(`  ${c.dim}Background mode starts at login, continues after this terminal closes, and restarts after failures.${c.reset}`);
  console.log(`  ${c.dim}The computer must remain powered on, awake, and connected to the internet.${c.reset}`);
  blankLine();

  return promptYesNo('  Install the background service now?', DEFAULT_INSTALL_BACKGROUND_SERVICE);
}

/** Starts the agent the way the caller asked for, and returns. */
async function launch(config: TunnelConfig, flags: Flags, lease?: { serviceWasActive: boolean }): Promise<void> {
  if (await chooseBackgroundMode(flags)) {
    saveCredentials(config.tunnelId, config.token, config.apiUrl);
    renderServiceAction('install', SERVICE_ACTIONS.install.run());
    return;
  }

  if (lease?.serviceWasActive) {
    console.log(`  ${c.dim}Background service stays paused while this terminal holds the tunnel.${c.reset}`);
    console.log(`  ${c.dim}Resume it with${c.reset} ${c.white}agent-tunnel start${c.reset}${c.dim}, or leave it — it starts again at login.${c.reset}`);
  }
  startAgent(config);
}

async function pairThisMachine(apiUrl: string, flags: Flags): Promise<void> {
  blankLine();
  console.log(`  ${glyph.mark} ${c.bold}Device Authorization${c.reset}`);
  blankLine();

  let challenge;
  try {
    challenge = await requestDeviceAuthorization(apiUrl);
  } catch (error) {
    fail(
      error instanceof InvalidDeviceAuthResponseError
        ? error.message
        : 'Failed to start device authorization',
    );
  }

  console.log(`  ${c.dim}Code:${c.reset}  ${c.bold}${c.white}${challenge.deviceCode}${c.reset}`);
  blankLine();
  console.log(`  ${c.dim}Open this URL on any device to approve:${c.reset}`);
  console.log(`  ${c.cyan}${challenge.verificationUrl}${c.reset}`);
  blankLine();
  openBrowser(challenge.verificationUrl);

  let outcome;
  try {
    outcome = await awaitDeviceAuthorization(apiUrl, challenge, {
      onWaiting: (secondsRemaining) => {
        const minutes = Math.floor(secondsRemaining / 60);
        const seconds = String(secondsRemaining % 60).padStart(2, '0');
        process.stdout.write(`\r  ${c.dim}Waiting for approval... ${c.white}${minutes}:${seconds}${c.reset}  `);
      },
    });
  } catch (error) {
    process.stdout.write(`\r${' '.repeat(60)}\r`);
    fail(error instanceof Error ? error.message : 'Device authorization failed');
  }
  process.stdout.write(`\r${' '.repeat(60)}\r`);

  if (outcome.status === 'denied') fail('Authorization denied.');
  if (outcome.status === 'expired') fail('Authorization expired. Please try again.');
  if (outcome.status === 'approved-without-token') {
    fail('Authorization was approved, but the setup token was not available. Run connect again.');
  }

  // The approved set is a ceiling only re-pairing can widen. Saving an empty one
  // yields a tunnel that connects, reports success, and can do nothing.
  if (outcome.capabilities.length === 0) {
    console.log(`  ${glyph.bad} ${c.bold}No capabilities were approved${c.reset}`);
    blankLine();
    console.log(`  ${c.dim}A tunnel with no capabilities connects but cannot act, and the${c.reset}`);
    console.log(`  ${c.dim}approved set can only be changed by pairing again. Nothing was saved.${c.reset}`);
    blankLine();
    console.log(`  ${c.dim}Run connect again and approve at least one of${c.reset} ${c.white}${ALL_CAPABILITIES.join(', ')}${c.reset}${c.dim}.${c.reset}`);
    blankLine();
    process.exit(1);
  }

  console.log(`  ${glyph.on} ${c.bold}Authorized${c.reset}`);
  saveCredentials(outcome.tunnelId, outcome.token, apiUrl, outcome.capabilities);
  console.log(`  ${c.dim}Saved to ${CONFIG_FILE}${c.reset}`);
  console.log(`  ${c.dim}Access: ${outcome.capabilities.join(', ')}${c.reset}`);
  blankLine();

  await launch(loadConfig({ apiUrl }), flags);
}

async function commandConnect(flags: Flags): Promise<void> {
  const config = loadConfig({
    token: flags.token,
    tunnelId: flags['tunnel-id'],
    apiUrl: flags['api-url'],
  });
  // Credentials typed on the command line, as opposed to ones loadConfig()
  // restored from disk. Only the latter may be discarded and re-paired.
  const explicitCredentials = Boolean(flags.token && flags['tunnel-id']);

  if (Boolean(config.token) !== Boolean(config.tunnelId)) {
    fail('Provide both --token and --tunnel-id, or neither (for device auth)');
  }

  if (!config.token) {
    await pairThisMachine(config.apiUrl, flags);
    return;
  }

  if (isTruthyFlag(flags.reauth) && !explicitCredentials) {
    clearSavedCredentials();
    await pairThisMachine(config.apiUrl, flags);
    return;
  }

  // Take the credential from the background service before probing, so the two
  // never race for the single connection the relay allows.
  const lease = acquireTunnelLease();
  blankLine();
  console.log(`  ${glyph.mark} ${c.dim}Checking saved credentials…${c.reset}`);

  let probe;
  try {
    probe = await probeCredentials(config, {
      capabilities: createEnabledCapabilityRegistry(config).getCapabilityNames(),
    });
  } catch (error) {
    lease.resumeService();
    throw error;
  }

  if (probe === 'unreachable') {
    // The credential is unproven, so restore exactly what was running before.
    lease.resumeService();
    fail(`Cannot reach the relay at ${config.apiUrl}. Check your network, then run connect again.`);
  }

  if (probe === 'rejected') {
    if (explicitCredentials) fail('The supplied --token was rejected for this tunnel.');
    console.log(`  ${glyph.warn} ${c.dim}Saved token rejected — re-authorizing${c.reset}`);
    clearSavedCredentials();
    await pairThisMachine(config.apiUrl, flags);
    return;
  }

  await launch(config, flags, lease);
}

// ── other commands ───────────────────────────────────────────────────────────

function commandRun(flags: Flags): void {
  const config = loadConfig({
    token: flags.token,
    tunnelId: flags['tunnel-id'],
    apiUrl: flags['api-url'],
  });
  const asService = flags.service === 'true';

  if (!config.token || !config.tunnelId) {
    console.error(`  ${glyph.bad} No saved tunnel credentials found. Run \`agent-tunnel connect\` first.`);
    // Restarting cannot conjure a credential. Under a supervisor this exits
    // cleanly so the service stops instead of respawning forever.
    process.exit(asService ? TERMINAL_SERVICE_EXIT_CODE : 1);
  }

  if (asService) rotateServiceLogs();
  startAgent(config, { service: asService });
}

/** Last agent line in the service log, so status reports evidence not a guess. */
function lastServiceActivity(): string | null {
  try {
    const lines = readFileSync(join(getServicePaths().logDir, 'agent-tunnel.out.log'), 'utf8')
      .split(/\r?\n/)
      .map((line) => stripAnsi(line).trim())
      .filter((line) => line.length > 0);
    return lines.at(-1) ?? null;
  } catch {
    return null;
  }
}

function commandStatus(flags: Flags): void {
  const config = loadConfig({ apiUrl: flags['api-url'] });
  const service = getServiceStatus();
  const paired = Boolean(config.token && config.tunnelId);
  const approved = new Set(config.enabledCapabilities ?? []);

  if (isTruthyFlag(flags.json)) {
    console.log(JSON.stringify({
      paired,
      tunnelId: paired ? config.tunnelId : null,
      apiUrl: config.apiUrl,
      capabilities: [...approved],
      version: agentTunnelVersion(),
      service,
      lastActivity: lastServiceActivity(),
    }, null, 2));
    return;
  }

  blankLine();
  console.log(`  ${glyph.mark}  ${c.bold}${c.white}Agent Tunnel${c.reset} ${c.dim}v${agentTunnelVersion()}${c.reset}   ${c.dim}${hostname()}${c.reset}`);
  blankLine();

  if (!paired) {
    console.log(`  ${glyph.off} ${c.bold}Not paired${c.reset}`);
    blankLine();
    console.log(`  ${c.dim}Pair this machine:${c.reset} ${c.white}agent-tunnel connect --api-url <url>${c.reset}`);
    blankLine();
    return;
  }

  field('tunnel', `${c.white}${config.tunnelId}${c.reset}`);
  field('relay', `${c.white}${config.apiUrl}${c.reset}`);
  field('capabilities', ALL_CAPABILITIES
    .map((name) => approved.has(name) ? `${glyph.on} ${c.white}${name}${c.reset}` : `${c.gray}○ ${name}${c.reset}`)
    .join('   '));
  blankLine();
  field('service', describeService(service));
  if (service.installed && service.path) field('', `${c.dim}${shortenHomePath(service.path)}${c.reset}`);

  const activity = lastServiceActivity();
  if (activity) field('last log', `${c.dim}${activity}${c.reset}`);
  blankLine();

  if (approved.size === 0) {
    console.log(`  ${glyph.warn} ${c.dim}No capabilities approved — this tunnel cannot act.${c.reset}`);
    console.log(`  ${c.dim}Pair again with${c.reset} ${c.white}agent-tunnel connect --reauth${c.reset}`);
    blankLine();
  }
  console.log(`  ${c.dim}Recent logs:${c.reset} ${c.white}agent-tunnel logs${c.reset}`);
  blankLine();
}

function commandLogout(flags: Flags): void {
  const removed = clearSavedCredentials();
  const keepService = isTruthyFlag(flags['keep-service']);
  if (!keepService) SERVICE_ACTIONS.uninstall.run();

  blankLine();
  console.log(removed
    ? `  ${glyph.on} ${c.bold}Signed out${c.reset} ${c.dim}(credentials cleared from ${CONFIG_FILE})${c.reset}`
    : `  ${glyph.off} ${c.dim}No saved credentials to clear${c.reset}`);
  console.log(keepService
    ? `  ${glyph.warn} ${c.dim}Background service kept — it cannot authenticate until you connect again${c.reset}`
    : `  ${c.dim}Background service removed${c.reset}`);
  blankLine();
  console.log(`  ${c.dim}Pair again with:${c.reset} ${c.white}agent-tunnel connect --api-url <url>${c.reset}`);
  blankLine();
}

function commandLogs(flags: Flags): void {
  const paths = getServicePaths();

  if (isTruthyFlag(flags.clear)) {
    for (const file of serviceLogFiles(paths)) {
      try { writeFileSync(file, '', { mode: 0o600 }); } catch {}
    }
    blankLine();
    console.log(`  ${glyph.on} ${c.dim}Service logs cleared${c.reset}`);
    blankLine();
    return;
  }

  const requested = Number.parseInt(flags.lines ?? '', 10);
  const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_LOG_LINES;
  const showAll = isTruthyFlag(flags.all);

  for (const [label, file] of [
    ['output', join(paths.logDir, 'agent-tunnel.out.log')],
    ['errors', join(paths.logDir, 'agent-tunnel.err.log')],
  ] as const) {
    blankLine();
    console.log(`  ${c.bold}${c.white}${label}${c.reset}  ${c.dim}${shortenHomePath(file)}${c.reset}`);

    if (!existsSync(file)) {
      console.log(`  ${c.dim}not created yet${c.reset}`);
      continue;
    }

    const kept = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => showAll || !isShellStartupNoise(line));

    const lines = collapseRepeatedLines(kept).slice(-limit);
    if (lines.length === 0) {
      console.log(`  ${c.dim}empty${c.reset}`);
      continue;
    }
    for (const line of lines) console.log(`  ${line}`);
  }
  blankLine();
  console.log(`  ${c.dim}--lines <n> to show more, --all to keep shell noise, --clear to empty them.${c.reset}`);
  blankLine();
}

function commandServiceAction(action: ServiceAction, flags: Flags): void {
  if (action === 'install') {
    const config = loadConfig({
      token: flags.token,
      tunnelId: flags['tunnel-id'],
      apiUrl: flags['api-url'],
    });
    if (!config.token || !config.tunnelId) {
      fail('No saved tunnel credentials found. Run `agent-tunnel connect` first, or pass --token and --tunnel-id.');
    }
    if (flags.token && flags['tunnel-id']) {
      saveCredentials(config.tunnelId, config.token, config.apiUrl);
    }
  }
  renderServiceAction(action, SERVICE_ACTIONS[action].run());
}

// ── dispatch ─────────────────────────────────────────────────────────────────

interface Command {
  summary: string;
  run: (flags: Flags) => void | Promise<void>;
  aliases?: readonly string[];
  hidden?: boolean;
}

const COMMANDS: Record<string, Command> = {
  connect: {
    summary: 'Pair this machine, then run it in the background or this terminal',
    run: commandConnect,
  },
  status: { summary: 'Show pairing, capabilities, and service state (--json)', run: commandStatus },
  logs: { summary: 'Show recent service logs (--lines <n>, --all, --clear)', run: commandLogs },
  start: { summary: 'Start the background service', run: (f) => commandServiceAction('start', f) },
  stop: {
    summary: 'Stop the background service (keeps it installed)',
    run: (f) => commandServiceAction('stop', f),
    aliases: ['disable'],
  },
  restart: { summary: 'Restart the background service', run: (f) => commandServiceAction('restart', f) },
  'install-service': {
    summary: 'Install and start the background service',
    run: (f) => commandServiceAction('install', f),
  },
  'uninstall-service': {
    summary: 'Stop and remove the background service',
    run: (f) => commandServiceAction('uninstall', f),
  },
  'service-status': {
    summary: 'Show the background service state (same view as status)',
    run: commandStatus,
  },
  logout: { summary: 'Clear saved credentials and remove the service', run: commandLogout },
  run: { summary: 'Run using saved credentials (used by the service)', run: commandRun },
  'start-service': { summary: '', run: (f) => commandServiceAction('start', f), hidden: true },
  'stop-service': { summary: '', run: (f) => commandServiceAction('stop', f), hidden: true },
  'restart-service': { summary: '', run: (f) => commandServiceAction('restart', f), hidden: true },
  'sign-out': { summary: '', run: commandLogout, hidden: true },
  unpair: { summary: '', run: commandLogout, hidden: true },
};

const OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['--api-url <url>', 'Relay API URL'],
  ['--token <token> --tunnel-id <id>', 'Skip device auth and use an explicit credential'],
  ['--reauth', 'With connect: discard the saved credential and pair again'],
  ['--daemon / --foreground', 'With connect: skip the prompt and choose the mode'],
  ['--json', 'With status: machine-readable output'],
  ['--keep-service', 'With logout: keep the background service installed'],
];

function showHelp(): void {
  blankLine();
  console.log(`  ${c.cyan}▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀${c.reset}   ${c.cyan}▀█▀ █ █ █▄ █ █▄ █ █▀▀ █  ${c.reset}`);
  console.log(`  ${c.cyan}█▀█ █▄█ ██▄ █ ▀█  █${c.reset}    ${c.cyan} █  █▄█ █ ▀█ █ ▀█ ██▄ █▄▄${c.reset}`);
  blankLine();
  console.log(`  ${c.dim}Secure bridge between AI agents & local machines${c.reset}`);
  blankLine();
  console.log(`  ${c.bold}Usage${c.reset}   ${c.dim}npx --yes @kortix/agent-tunnel@latest <command> [options]${c.reset}`);
  blankLine();

  console.log(`${c.gray}  ── Commands ────────────────────────────────────────${c.reset}`);
  const visible = Object.entries(COMMANDS).filter(([, command]) => !command.hidden);
  const width = Math.max(...visible.map(([name]) => name.length)) + 2;
  for (const [name, command] of visible) {
    console.log(`  ${c.cyan}${name.padEnd(width)}${c.reset}${command.summary}`);
  }
  blankLine();

  console.log(`${c.gray}  ── Options ─────────────────────────────────────────${c.reset}`);
  const optionWidth = Math.max(...OPTIONS.map(([flag]) => flag.length)) + 2;
  for (const [flag, description] of OPTIONS) {
    console.log(`  ${c.white}${flag.padEnd(optionWidth)}${c.reset}${c.dim}${description}${c.reset}`);
  }
  blankLine();
  console.log(`  ${c.dim}Config: ${CONFIG_FILE}${c.reset}`);
  console.log(`  ${c.dim}powered by ${c.cyan}kortix${c.reset}`);
  blankLine();
}

const { command, flags } = parseArgs(process.argv);

if (Object.prototype.hasOwnProperty.call(flags, 'keep-awake')) {
  console.error(`  ${glyph.bad} --keep-awake is not supported. Configure sleep behavior in the operating system.`);
  process.exit(2);
}

const resolved =
  COMMANDS[command] ??
  Object.values(COMMANDS).find((entry) => entry.aliases?.includes(command));

if (!resolved) {
  showHelp();
} else {
  void Promise.resolve(resolved.run(flags)).catch((error: unknown) => {
    console.error(`  ${glyph.bad} ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
