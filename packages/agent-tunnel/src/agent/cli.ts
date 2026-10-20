import '../node-ws-polyfill';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

import { PAIR_AGAIN_COMMAND, TunnelAgent } from './agent';
import {
  accessAfterPairing,
  accessFilePath,
  accessRequestPath,
  accessView,
  applyAccess,
  desktopAppPath,
  readAccess,
  writeAccess,
  type AccessChange,
  type AccessView,
} from './access';
import { printStartupBanner } from './banner';
import { createEnabledCapabilityRegistry, desktopUnavailableReason } from './capabilities/enabled-registry';
import { loadConfig, type TunnelConfig } from './config';
import { CONFIG_FILE, clearSavedCredentials, saveCredentials } from './credential-store';
import { probeCredentials } from './credential-probe';
import {
  InvalidDeviceAuthResponseError,
  UUID_PATTERN,
  awaitDeviceAuthorization,
  openBrowser,
  requestDeviceAuthorization,
} from './device-auth';
import { collapseRepeatedLines, isShellStartupNoise } from './log-format';
import { anyFlag, isInteractiveTerminal, isTruthyFlag } from './prompts';
import {
  agentTunnelHome,
  getServicePaths,
  getServiceStatus,
  installedAppRunner,
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
import { watchForRestart } from './self-restart';
import { readAgentState, writeAgentState } from './state-file';
import { blankLine, c, clearScreen, field, glyph, stripAnsi } from './terminal';
import { agentTunnelVersion } from './version';

const ALL_CAPABILITIES = ['filesystem', 'shell', 'desktop'] as const;
const BACKGROUND_FLAGS = ['daemon', 'service', 'background', 'always-online'] as const;
const FOREGROUND_FLAGS = ['foreground', 'no-daemon', 'no-service', 'no-background'] as const;
const DEFAULT_LOG_LINES = 60;

/** `_` holds the words after the command (`access always` → `_: 'always'`). */
type Flags = Record<string, string>;

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  const words: string[] = [];
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }
    const next = argv[i + 1];
    flags[arg.slice(2)] = next && !next.startsWith('--') ? argv[++i] : 'true';
  }
  if (words.length > 0) flags._ = words.join(' ');
  return { command: argv[2] || 'help', flags };
}

// ── machine-readable events (connect --json) ─────────────────────────────────

/**
 * `--json` turns `connect` into newline-delimited JSON events on stdout for a
 * program such as the desktop app: `challenge`, `approved`, `service`, `error`.
 * It never prompts and never opens a browser; the caller shows the URL.
 */
let jsonMode = false;
const writeStdout = process.stdout.write.bind(process.stdout);

function emit(event: string, fields: Record<string, unknown> = {}): void {
  writeStdout(`${JSON.stringify({ event, ...fields })}\n`);
}

function fail(message: string): never {
  if (jsonMode) emit('error', { message });
  else console.error(`  ${glyph.bad} ${message}`);
  process.exit(1);
}

function shortenHomePath(path: string): string {
  const home = process.env.HOME ?? '';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// ── running the agent ────────────────────────────────────────────────────────

function startAgent(config: TunnelConfig, options: { service?: boolean } = {}): void {
  if (jsonMode) {
    // The agent logs to stdout. Keep stdout pure NDJSON for the caller.
    // ponytail: redirect by rebinding; give TunnelAgent a log sink if a second caller needs one.
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
    options = { ...options, service: true };
  }
  let agent: TunnelAgent | null = null;
  const restart = options.service
    ? watchForRestart((reason) => {
        process.stdout.write(`[agent-tunnel] restarting: ${reason}\n`);
        agent?.disconnect();
        process.exit(0);
      })
    : null;
  const registry = createEnabledCapabilityRegistry(config, undefined, {
    onPermissionMissing: restart?.permissionMissing,
  });
  const desktopReason = registry.unavailable.get('desktop');
  if (desktopReason) console.error(`[agent-tunnel] Computer Use is approved but unavailable: ${desktopReason}`);

  if (options.service) {
    process.stdout.write(`[agent-tunnel] service starting: ${config.tunnelId} -> ${config.apiUrl}\n`);
  } else {
    clearScreen();
    void printStartupBanner({
      tunnelId: config.tunnelId,
      apiUrl: config.apiUrl,
      capabilities: registry.getCapabilityNames(),
      version: agentTunnelVersion(),
    });
  }

  // A service never stops on its own (R2): a refused credential waits in
  // `rejected` and re-reads config.json, so pairing again heals it.
  agent = new TunnelAgent(
    config,
    registry,
    // The agent passes the credential it uses NOW: a re-pair picked up by a
    // `rejected` service has a new tunnelId, and state.json must name it.
    { onStatus: (status, current) => writeAgentState(status, current) },
    {
      persistent: options.service === true,
      reloadConfig: () => loadConfig({ apiUrl: config.apiUrl }),
    },
  );
  // Before connect(): connect() writes state.json, and a SIGTERM that lands
  // before a handler exists kills the process with the state left `connecting`.
  const shutdown = () => {
    if (!options.service) console.log(`\n${c.dim}  Shutting down…${c.reset}`);
    agent?.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  agent.connect();
}

// ── pairing ──────────────────────────────────────────────────────────────────

/**
 * A person at a terminal gets what the desktop app gives: a background
 * connection, no question asked, and the exact commands that pause, resume,
 * and remove it. `--foreground` keeps it in this terminal only. A script
 * (no TTY) or `--json` keeps the foreground default it always had.
 */
function chooseBackgroundMode(flags: Flags): boolean {
  if (anyFlag(flags, BACKGROUND_FLAGS)) return true;
  if (anyFlag(flags, FOREGROUND_FLAGS)) return false;
  return !jsonMode && isInteractiveTerminal();
}

function printServiceControls(): void {
  const npx = 'npx @kortix/agent-tunnel@latest';
  console.log(`  ${c.dim}Runs in the background: starts at login, restarts after failures, keeps running after this terminal closes.${c.reset}`);
  if (installedAppRunner()) {
    console.log(`  ${c.dim}It runs on the Kortix app on this Mac: same connection, same macOS permissions. Control it from Your computer in the app.${c.reset}`);
  }
  blankLine();
  field('Pause', `${c.white}${npx} stop${c.reset}`);
  field('Resume', `${c.white}${npx} start${c.reset}`);
  field('Disconnect', `${c.white}${npx} logout${c.reset}`);
  blankLine();
}

/** Starts the agent the way the caller asked for, and returns. */
async function launch(config: TunnelConfig, flags: Flags, lease?: { serviceWasActive: boolean }): Promise<void> {
  if (chooseBackgroundMode(flags)) {
    saveCredentials(config.tunnelId, config.token, config.apiUrl);
    if (!jsonMode) {
      renderServiceAction('install', SERVICE_ACTIONS.install.run());
      printServiceControls();
      return;
    }
    // Return instead of process.exit(): an exit can cut off a piped stdout.
    try {
      const status = SERVICE_ACTIONS.install.run();
      // Installed is not enough: a job launchd did not load keeps the computer offline.
      const ok = status.installed && status.active === true;
      emit('service', { action: 'install', ok, active: status.active, detail: status.detail ?? '' });
      if (!ok) process.exitCode = 1;
    } catch (error) {
      emit('service', { action: 'install', ok: false, detail: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
    return;
  }

  if (lease?.serviceWasActive && !jsonMode) {
    console.log(`  ${c.dim}Background service stays paused while this terminal holds the tunnel.${c.reset}`);
    console.log(`  ${c.dim}Resume it with${c.reset} ${c.white}agent-tunnel start${c.reset}${c.dim}, or leave it — it starts again at login.${c.reset}`);
  }
  startAgent(config);
}

async function pairThisMachine(apiUrl: string, flags: Flags, lease?: { serviceWasActive: boolean }): Promise<void> {
  if (!jsonMode) {
    blankLine();
    console.log(`  ${glyph.mark} ${c.bold}Device Authorization${c.reset}`);
    blankLine();
  }

  let challenge;
  try {
    challenge = await requestDeviceAuthorization(apiUrl, { projectId: flags['project-id'] });
  } catch (error) {
    fail(
      error instanceof InvalidDeviceAuthResponseError
        ? error.message
        : 'Failed to start device authorization',
    );
  }

  if (jsonMode) {
    emit('challenge', {
      deviceCode: challenge.deviceCode,
      verificationUrl: challenge.verificationUrl,
      expiresAt: challenge.expiresAt,
    });
  } else {
    console.log(`  ${c.dim}Code:${c.reset}  ${c.bold}${c.white}${challenge.deviceCode}${c.reset}`);
    blankLine();
    console.log(`  ${c.dim}Open this URL on any device to approve:${c.reset}`);
    console.log(`  ${c.cyan}${challenge.verificationUrl}${c.reset}`);
    blankLine();
    openBrowser(challenge.verificationUrl);
  }

  const clearWaiting = () => { if (!jsonMode) process.stdout.write(`\r${' '.repeat(60)}\r`); };
  let outcome;
  try {
    outcome = await awaitDeviceAuthorization(apiUrl, challenge, {
      onWaiting: jsonMode ? undefined : (secondsRemaining) => {
        const minutes = Math.floor(secondsRemaining / 60);
        const seconds = String(secondsRemaining % 60).padStart(2, '0');
        process.stdout.write(`\r  ${c.dim}Waiting for approval... ${c.white}${minutes}:${seconds}${c.reset}  `);
      },
    });
  } catch (error) {
    clearWaiting();
    fail(error instanceof Error ? error.message : 'Device authorization failed');
  }
  clearWaiting();

  if (outcome.status === 'denied') fail('Authorization denied.');
  if (outcome.status === 'expired') fail('Authorization expired. Please try again.');
  if (outcome.status === 'approved-without-token') {
    fail('Authorization was approved, but the setup token was not available. Run connect again.');
  }

  // The approved set is a ceiling only re-pairing can widen. Saving an empty one
  // yields a tunnel that connects, reports success, and can do nothing.
  if (outcome.capabilities.length === 0) {
    if (jsonMode) fail('No capabilities were approved. Nothing was saved. Pair again and approve at least one capability.');
    console.log(`  ${glyph.bad} ${c.bold}No capabilities were approved${c.reset}`);
    blankLine();
    console.log(`  ${c.dim}A tunnel with no capabilities connects but cannot act, and the${c.reset}`);
    console.log(`  ${c.dim}approved set can only be changed by pairing again. Nothing was saved.${c.reset}`);
    blankLine();
    console.log(`  ${c.dim}Run connect again and approve at least one of${c.reset} ${c.white}${ALL_CAPABILITIES.join(', ')}${c.reset}${c.dim}.${c.reset}`);
    blankLine();
    process.exit(1);
  }

  saveCredentials(outcome.tunnelId, outcome.token, apiUrl, outcome.capabilities);
  // A1: a re-pair keeps the owner's mode; a first pairing asks when the
  // desktop app can answer, else always (see accessAfterPairing).
  writeAccess(accessAfterPairing(agentTunnelHome(), existsSync(desktopAppPath())));
  if (jsonMode) {
    emit('approved', { tunnelId: outcome.tunnelId, capabilities: outcome.capabilities });
  } else {
    console.log(`  ${glyph.on} ${c.bold}Authorized${c.reset}`);
    console.log(`  ${c.dim}Saved to ${CONFIG_FILE}${c.reset}`);
    console.log(`  ${c.dim}Access: ${outcome.capabilities.join(', ')}${c.reset}`);
    blankLine();
  }

  await launch(loadConfig({ apiUrl }), flags, lease);
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
  if (flags['project-id'] !== undefined && !UUID_PATTERN.test(flags['project-id'])) {
    fail('--project-id must be a project UUID');
  }

  // X6: a credential saved for another backend is never sent to this one. Pair
  // afresh; the other pairing stays on disk until this one succeeds.
  const savedForOtherBackend =
    Boolean(config.token) && !explicitCredentials && Boolean(flags['api-url']) &&
    new URL(loadConfig().apiUrl).origin !== new URL(config.apiUrl).origin;

  // Take the credential from the background service before probing or pairing:
  // the relay allows one connection, and a waiting or `rejected` service picks
  // up a new pairing within seconds and would displace this process.
  const lease = acquireTunnelLease();

  if (!config.token || savedForOtherBackend) {
    await pairThisMachine(config.apiUrl, flags, lease);
    return;
  }

  if (isTruthyFlag(flags.reauth) && !explicitCredentials) {
    clearSavedCredentials();
    await pairThisMachine(config.apiUrl, flags, lease);
    return;
  }

  if (!jsonMode) {
    blankLine();
    console.log(`  ${glyph.mark} ${c.dim}Checking saved credentials…${c.reset}`);
  }

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
    if (!jsonMode) console.log(`  ${glyph.warn} ${c.dim}Saved token rejected — re-authorizing${c.reset}`);
    clearSavedCredentials();
    await pairThisMachine(config.apiUrl, flags, lease);
    return;
  }

  // The saved pairing is still valid: report it as the approved credential.
  if (jsonMode) {
    emit('approved', { tunnelId: config.tunnelId, capabilities: config.enabledCapabilities ?? [], existing: true });
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
    if (!asService) {
      console.error(`  ${glyph.bad} No saved tunnel credentials found. Run \`agent-tunnel connect\` first.`);
      process.exit(1);
    }
    // R2: the supervisor restarts on every exit, so exiting would only spin.
    // Wait for a pairing to write the credential instead.
    process.stdout.write('[agent-tunnel] no saved credential — waiting for a credential (pair this computer to start)\n');
    const wait = setInterval(() => {
      const next = loadConfig({ apiUrl: flags['api-url'] });
      if (!next.token || !next.tunnelId) return;
      clearInterval(wait);
      rotateServiceLogs();
      startAgent(next, { service: true });
    }, 60_000);
    return;
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
  const desktopReason = approved.has('desktop') ? desktopUnavailableReason() : null;

  if (isTruthyFlag(flags.json)) {
    console.log(JSON.stringify({
      paired,
      tunnelId: paired ? config.tunnelId : null,
      apiUrl: config.apiUrl,
      capabilities: [...approved],
      unavailableCapabilities: desktopReason ? { desktop: desktopReason } : {},
      version: agentTunnelVersion(),
      home: agentTunnelHome(),
      serviceLabel: getServicePaths().label,
      service,
      state: readAgentState(),
      access: accessView(),
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
    console.log(`  ${c.dim}Pair again with${c.reset} ${c.white}${PAIR_AGAIN_COMMAND}${c.reset}`);
    blankLine();
  }
  console.log(`  ${c.dim}Recent logs:${c.reset} ${c.white}agent-tunnel logs${c.reset}`);
  blankLine();
}

/**
 * X4: `DELETE /v1/tunnel/self`, authenticated by this machine's own credential,
 * removes the machine and its accounts on the server. Best effort: a failure
 * never blocks the local sign-out.
 */
async function unpairOnServer(): Promise<boolean> {
  let config: TunnelConfig;
  try {
    config = loadConfig();
  } catch {
    return false;
  }
  if (!config.token || !config.tunnelId) return false;
  try {
    const response = await fetch(`${config.apiUrl}/self`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.token}`, 'X-Tunnel-Id': config.tunnelId },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function commandLogout(flags: Flags): Promise<void> {
  const serverUnpaired = await unpairOnServer();
  const removed = clearSavedCredentials();
  // The access answer belongs to this pairing; the next one starts fresh.
  rmSync(accessFilePath(), { force: true });
  rmSync(accessRequestPath(), { force: true });
  const keepService = isTruthyFlag(flags['keep-service']);
  if (!keepService) SERVICE_ACTIONS.uninstall.run();

  if (isTruthyFlag(flags.json)) {
    console.log(JSON.stringify({ ok: true, serverUnpaired, credentialsCleared: removed, serviceRemoved: !keepService }));
    return;
  }

  blankLine();
  console.log(serverUnpaired
    ? `  ${glyph.on} ${c.dim}Removed this computer from Kortix${c.reset}`
    : `  ${glyph.warn} ${c.dim}Could not reach Kortix — remove this computer from its settings${c.reset}`);
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

/** "Ask each time · allowed until 14:05", for a person at a terminal. */
function describeAccess(view: AccessView): string {
  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (view.mode === 'always') return `${c.white}Always allowed${c.reset}`;
  if (view.mode === 'off') return `${c.white}Off${c.reset} ${c.dim}(every agent call is refused)${c.reset}`;
  const now = view.grantedUntil
    ? `allowed until ${clock(view.grantedUntil)}`
    : view.deniedUntil
      ? `denied until ${clock(view.deniedUntil)}`
      : 'asks before the next call';
  return `${c.white}Ask each time${c.reset} ${c.dim}· ${now}${c.reset}`;
}

function printAccess(view: AccessView, flags: Flags): void {
  if (isTruthyFlag(flags.json)) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  const npx = 'npx @kortix/agent-tunnel@latest';
  blankLine();
  field('access', describeAccess(view));
  field('keep awake', view.keepAwakeSupported ? (view.keepAwake ? `${c.white}on${c.reset}` : `${c.white}off${c.reset}`) : `${c.dim}not available on this system${c.reset}`);
  if (view.pendingRequest) {
    field('waiting', `${c.white}${view.pendingRequest.change ? 'a change asked for through Kortix' : `an agent call (${view.pendingRequest.capability})`}${c.reset}`);
    field('', `${c.dim}${npx} access --allow-for 60   or   --deny${c.reset}`);
  }
  blankLine();
  console.log(`  ${c.dim}Change it:${c.reset} ${c.white}${npx} access ask|always|off${c.reset}${c.dim}, --allow-for <minutes>, --revoke, --deny${c.reset}`);
  blankLine();
}

/**
 * `access [ask|always|off] [--allow-for <minutes>] [--revoke] [--deny]`: when
 * Kortix may use this computer. The person at this machine is its owner, so
 * this widens access too; the desktop app runs this command after its own
 * confirmation. No change prints the current state.
 */
function commandAccess(flags: Flags): void {
  const change: AccessChange = {};
  if (flags._) change.mode = flags._ as AccessChange['mode'];
  if (flags['allow-for'] !== undefined) {
    change.grantMinutes = Number(flags['allow-for']);
    if (!(change.grantMinutes > 0)) fail('--allow-for takes minutes, at most 1440. Example: agent-tunnel access --allow-for 60');
  }
  if (isTruthyFlag(flags.revoke)) change.revoke = true;
  if (isTruthyFlag(flags.deny)) change.deny = true;
  if (Object.keys(change).length === 0) return printAccess(accessView(), flags);
  if (change.mode !== undefined && !['ask', 'always', 'off'].includes(change.mode)) {
    fail('Access is one of: ask, always, off. Example: agent-tunnel access ask');
  }
  // A grant applies in "Ask each time"; from another mode it means "ask, allowed for now".
  if (change.grantMinutes !== undefined && change.mode === undefined && readAccess().mode !== 'ask') change.mode = 'ask';
  printAccess(applyAccess(change), flags);
}

/** `keep-awake [on|off]`: hold off system sleep while the agent runs (macOS, Linux). */
function commandKeepAwake(flags: Flags): void {
  if (flags._ === undefined) return printAccess(accessView(), flags);
  if (flags._ !== 'on' && flags._ !== 'off') fail('Keep awake is on or off. Example: agent-tunnel keep-awake on');
  if (!accessView().keepAwakeSupported) fail('Keep awake is not available on this system yet.');
  printAccess(applyAccess({ keepAwake: flags._ === 'on' }), flags);
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
  access: {
    summary: 'When Kortix may use this computer: ask, always, off (--allow-for <min>, --revoke, --deny, --json)',
    run: commandAccess,
  },
  'keep-awake': { summary: 'Keep this computer awake while connected: on, off (--json)', run: commandKeepAwake },
  logs: { summary: 'Show recent service logs (--lines <n>, --all, --clear)', run: commandLogs },
  start: {
    summary: 'Start the background service (resumes a paused one)',
    run: (f) => commandServiceAction('start', f),
    aliases: ['resume'],
  },
  stop: {
    summary: 'Pause the background service; it stays stopped after restart until `start`',
    run: (f) => commandServiceAction('stop', f),
    aliases: ['disable', 'pause'],
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
    summary: 'Show the background service state (same view as status, --json)',
    run: commandStatus,
  },
  logout: { summary: 'Remove this computer from Kortix, clear credentials, remove the service', run: commandLogout },
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
  ['--project-id <uuid>', 'With connect: offer "Also share with <project>" on the approval page; the computer is yours in every project either way'],
  ['--json', 'With connect: NDJSON events, no prompts. With status, access, keep-awake, and logout: machine-readable output'],
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
  console.log(`  ${c.dim}Set AGENT_TUNNEL_HOME to use another config directory and service.${c.reset}`);
  console.log(`  ${c.dim}powered by ${c.cyan}kortix${c.reset}`);
  blankLine();
}

const { command, flags } = parseArgs(process.argv);
jsonMode = command === 'connect' && isTruthyFlag(flags.json);

if (Object.prototype.hasOwnProperty.call(flags, 'keep-awake')) {
  console.error(`  ${glyph.bad} --keep-awake is not a flag. Run: agent-tunnel keep-awake on`);
  process.exit(2);
}

const resolved =
  COMMANDS[command] ??
  Object.values(COMMANDS).find((entry) => entry.aliases?.includes(command));

if (!resolved) {
  showHelp();
} else {
  // `.then`: a command that throws synchronously reports like one that rejects.
  void Promise.resolve().then(() => resolved.run(flags)).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
