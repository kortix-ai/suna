import '../node-ws-polyfill';
import { loadConfig, type TunnelConfig } from './config';
import { TunnelAgent } from './agent';
import { createEnabledCapabilityRegistry } from './capabilities/enabled-registry';
import {
  DEFAULT_INSTALL_BACKGROUND_SERVICE,
  getServicePaths,
  getServiceStatus,
  installService,
  restartService,
  startService,
  stopService,
  uninstallService,
} from './service';
import { hostname, platform, arch, release } from 'os';
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { createInterface } from 'readline/promises';

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  cyan:    '\x1b[36m',
  blue:    '\x1b[34m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
  bgCyan:  '\x1b[46m',
  bgBlue:  '\x1b[44m',
};

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[2] || 'help';
  const flags: Record<string, string> = {};

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = value;
    }
  }

  return { command, flags };
}

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type ConnectMode = {
  background: boolean;
};

type ApprovedDeviceCredentials = {
  tunnelId: string;
  token: string;
};

type DeviceAuthChallenge = {
  deviceCode: string;
  deviceSecret: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
};

const TUNNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_TOKEN_PATTERN = /^kortix_tnl_[A-Za-z0-9_-]{32,64}$/;

class InvalidDeviceAuthResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeviceAuthResponseError';
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseApprovedDeviceCredentials(
  value: Record<string, unknown>,
): ApprovedDeviceCredentials {
  const { tunnelId, token } = value;
  if (typeof tunnelId !== 'string' || !TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid tunnel ID',
    );
  }
  if (typeof token !== 'string' || !SETUP_TOKEN_PATTERN.test(token)) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid setup token',
    );
  }
  return { tunnelId, token };
}

function parseDeviceAuthChallenge(value: unknown): DeviceAuthChallenge {
  if (!isJsonRecord(value)) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid challenge',
    );
  }
  const { deviceCode, deviceSecret, verificationUrl, expiresAt, pollIntervalMs } = value;
  if (typeof deviceCode !== 'string' || !/^[A-Z]{4}-[0-9]{4}$/.test(deviceCode)) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid device code',
    );
  }
  if (typeof deviceSecret !== 'string' || !/^[A-Za-z0-9]{32}$/.test(deviceSecret)) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid device secret',
    );
  }
  if (typeof verificationUrl !== 'string' || verificationUrl.length > 2048) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid verification URL',
    );
  }
  const browserUrl = normalizeBrowserUrl(verificationUrl);
  if (!browserUrl) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid verification URL',
    );
  }
  const parsedVerificationUrl = new URL(browserUrl);
  const loopback =
    parsedVerificationUrl.hostname === 'localhost' ||
    parsedVerificationUrl.hostname === '127.0.0.1' ||
    parsedVerificationUrl.hostname === '[::1]' ||
    parsedVerificationUrl.hostname === '::1';
  if (
    parsedVerificationUrl.username ||
    parsedVerificationUrl.password ||
    (parsedVerificationUrl.protocol !== 'https:' && !loopback)
  ) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an unsafe verification URL',
    );
  }
  if (typeof expiresAt !== 'string') {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid expiration',
    );
  }
  const expiresAtMs = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + 10 * 60_000) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid expiration',
    );
  }
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    (pollIntervalMs as number) < 250 ||
    (pollIntervalMs as number) > 10_000
  ) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an invalid poll interval',
    );
  }
  return {
    deviceCode,
    deviceSecret,
    verificationUrl: browserUrl,
    expiresAt,
    pollIntervalMs: pollIntervalMs as number,
  };
}

async function printStartup(config: { tunnelId: string; apiUrl: string }, capabilities: string[], version: string): Promise<void> {
  const machine = hostname();
  const plat = `${platform()} ${arch()}`;

  const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + '…' : s;
  const tunnelDisplay = truncate(config.tunnelId, 40);
  const apiDisplay = truncate(config.apiUrl, 40);
  const machineDisplay = truncate(machine, 28);

  // ── ASCII art ───────────────────────────────────────────
  console.log('');
  console.log(`      ${c.cyan}▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀${c.reset}   ${c.cyan}▀█▀ █ █ █▄ █ █▄ █ █▀▀ █  ${c.reset}`);
  console.log(`      ${c.cyan}█▀█ █▄█ ██▄ █ ▀█  █${c.reset}    ${c.cyan} █  █▄█ █ ▀█ █ ▀█ ██▄ █▄▄${c.reset}`);
  console.log('');

  // ── Tunnel connection animation ─────────────────────────
  const barW = 50;
  const frames = 14;

  for (let i = 0; i <= frames; i++) {
    const filled = Math.round((i / frames) * barW);
    const empty = barW - filled;
    process.stdout.write(
      `\r      ${c.cyan}◇${c.reset} ${c.cyan}${'═'.repeat(filled)}${c.reset}${c.gray}${'─'.repeat(empty)}${c.reset}  `,
    );
    await sleep(20);
  }
  process.stdout.write(`\r      ${c.cyan}◇ ${'═'.repeat(barW)} ◆${c.reset}  \n`);
  await sleep(120);

  // ── Info box ────────────────────────────────────────────
  const W = 60;
  const vLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

  const row = (content: string) => {
    const pad = Math.max(0, W - vLen(content));
    console.log(`  ${c.gray}│${c.reset}${content}${' '.repeat(pad)}${c.gray}│${c.reset}`);
  };

  const blank = () => console.log(`  ${c.gray}│${c.reset}${' '.repeat(W)}${c.gray}│${c.reset}`);

  const titleL = `   ${c.cyan}◆${c.reset}  ${c.bold}${c.white}Agent Tunnel${c.reset}`;
  const titleR = `${c.dim}v${version}${c.reset}   `;
  const titleLLen = 18;
  const titleRLen = 1 + version.length + 3;
  const titlePad = Math.max(1, W - titleLLen - titleRLen);

  const capStr = capabilities
    .map(name => `${c.green}●${c.reset} ${c.white}${name}${c.reset}`)
    .join('   ');

  const brand = 'created by kortix';
  const brandFill = W - brand.length - 3;

  console.log('');
  console.log(`  ${c.gray}╭${'─'.repeat(W)}╮${c.reset}`);
  blank();
  row(`${titleL}${' '.repeat(titlePad)}${titleR}`);
  row(`   ${c.dim}Bridge between AI agents & local machines${c.reset}`);
  blank();
  row(`   ${c.dim}tunnel${c.reset}    ${c.white}${tunnelDisplay}${c.reset}`);
  row(`   ${c.dim}relay${c.reset}     ${c.white}${apiDisplay}${c.reset}`);
  row(`   ${c.dim}machine${c.reset}   ${c.white}${machineDisplay}${c.reset} ${c.dim}(${plat})${c.reset}`);
  blank();
  console.log(`  ${c.gray}╰${'─'.repeat(brandFill)} ${c.dim}created by ${c.cyan}kortix${c.reset} ${c.gray}─╯${c.reset}`);
  console.log('');
}

function startAgent(config: TunnelConfig, options: { service?: boolean } = {}): void {
  const registry = createEnabledCapabilityRegistry(config);
  if (config.enabledCapabilities?.includes('desktop') && !registry.has('desktop')) {
    console.error(
      '[agent-tunnel] Computer Use is approved but unavailable: install the trusted cua-driver locally, then restart Agent Tunnel.',
    );
  }

  if (!options.service) {
    clearScreen();
    printStartup(config, registry.getCapabilityNames(), '0.1.2');
  } else {
    console.log(`[agent-tunnel] service starting: ${config.tunnelId} -> ${config.apiUrl}`);
  }

  const agent = new TunnelAgent(config, registry);
  agent.connect();

  const shutdown = () => {
    if (!options.service) console.log(`\n${c.dim}  Shutting down…${c.reset}`);
    agent.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function normalizeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  if (process.env.KORTIX_AGENT_TUNNEL_NO_BROWSER === '1') return;
  const safeUrl = normalizeBrowserUrl(url);
  if (!safeUrl) return;
  try {
    const plat = platform();
    let command: string;
    let args: string[];
    if (plat === 'darwin') {
      command = 'open';
      args = [safeUrl];
    } else if (plat === 'win32') {
      command = 'rundll32.exe';
      args = ['url.dll,FileProtocolHandler', safeUrl];
    } else {
      command = 'xdg-open';
      args = [safeUrl];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

const CONFIG_DIR = join(homedir(), '.agent-tunnel');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function isSetupTunnelToken(token: string): boolean {
  return token.startsWith('kortix_tnl_') || token.startsWith('tnl_');
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      console.log(`  ${c.yellow}!${c.reset} Please answer yes or no.`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      process.stdout.write('\n');
      process.exit(130);
    }
    throw error;
  } finally {
    rl.close();
  }
}

async function chooseConnectMode(flags: Record<string, string>): Promise<ConnectMode> {
  const explicitBackground =
    isTruthyFlag(flags.daemon) ||
    isTruthyFlag(flags.service) ||
    isTruthyFlag(flags.background) ||
    isTruthyFlag(flags['always-online']);
  const explicitForeground =
    isTruthyFlag(flags.foreground) ||
    isTruthyFlag(flags['no-daemon']) ||
    isTruthyFlag(flags['no-service']) ||
    isTruthyFlag(flags['no-background']);

  if (explicitBackground) {
    return { background: true };
  }
  if (explicitForeground) {
    return { background: false };
  }
  if (!isInteractiveTerminal()) {
    return { background: false };
  }

  console.log('');
  console.log(`  ${c.yellow}!${c.reset} ${c.bold}Security note${c.reset}`);
  console.log(`  ${c.dim}Background mode starts at login, continues after this terminal closes, and restarts after failures.${c.reset}`);
  console.log(`  ${c.dim}The computer must remain powered on, awake, and connected to the internet.${c.reset}`);
  console.log('');

  const background = await promptYesNo(
    '  Install the background service now?',
    DEFAULT_INSTALL_BACKGROUND_SERVICE,
  );
  return { background };
}

function installBackgroundService(): void {
  const status = installService();
  console.log('');
  console.log(`  ${c.green}●${c.reset} ${c.bold}Background service installed${c.reset}`);
  if (status.path) console.log(`  ${c.dim}${status.path}${c.reset}`);
  console.log(`  ${c.dim}Starts at login and restarts after failures.${c.reset}`);
  if (status.detail) console.log(`  ${c.gray}${status.detail}${c.reset}`);
  console.log('');
}

function saveCredentials(
  tunnelId: string,
  token: string,
  apiUrl: string,
  enabledCapabilities?: string[],
): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch {}
  let existing: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) {
    try { existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  }
  const tmpFile = join(CONFIG_DIR, `config.${process.pid}.${Date.now()}.tmp`);
  const next = {
    ...existing,
    tunnelId,
    token,
    apiUrl,
    ...(enabledCapabilities !== undefined ? { enabledCapabilities } : {}),
  };
  // The device-auth response passes strict UUID and token-format validation.
  // The destination is a fixed private file under the current user's home.
  // lgtm[js/http-to-file-access]
  writeFileSync(tmpFile, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
  try { chmodSync(tmpFile, 0o600); } catch {}
  renameSync(tmpFile, CONFIG_FILE);
  try { chmodSync(CONFIG_FILE, 0o600); } catch {}
}

async function commandConnectDeviceAuth(config: TunnelConfig, flags: Record<string, string>): Promise<void> {
  console.log('');
  console.log(`  ${c.cyan}◆${c.reset} ${c.bold}Device Authorization${c.reset}`);
  console.log('');

  // Step 1: Create device auth request
  let deviceCode: string;
  let deviceSecret: string;
  let verificationUrl: string;
  let expiresAt: string;
  let pollIntervalMs: number;

  try {
    const res = await fetch(`${config.apiUrl}/device-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineHostname: hostname() }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`  ${c.red}✗${c.reset} Failed to create device auth request: ${res.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const challenge = parseDeviceAuthChallenge(await res.json());
    deviceCode = challenge.deviceCode;
    deviceSecret = challenge.deviceSecret;
    verificationUrl = challenge.verificationUrl;
    expiresAt = challenge.expiresAt;
    pollIntervalMs = challenge.pollIntervalMs;
  } catch (err) {
    const detail = err instanceof InvalidDeviceAuthResponseError ? `: ${err.message}` : '';
    console.error(`  ${c.red}✗${c.reset} Failed to start device authorization${detail}`);
    process.exit(1);
    return;
  }

  // Step 2: Display code and open browser
  console.log(`  ${c.dim}Code:${c.reset}  ${c.bold}${c.white}${deviceCode}${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Open this URL on any device to approve:${c.reset}`);
  console.log(`  ${c.cyan}${verificationUrl}${c.reset}`);
  console.log('');

  openBrowser(verificationUrl);

  // Step 3: Poll for approval
  const expiresAtMs = new Date(expiresAt).getTime();

  while (true) {
    const remaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    if (remaining <= 0) {
      console.log(`\n  ${c.red}✗${c.reset} Authorization expired. Please try again.`);
      process.exit(1);
    }

    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    process.stdout.write(`\r  ${c.dim}Waiting for approval... ${c.white}${min}:${sec.toString().padStart(2, '0')}${c.reset}  `);

    try {
      const res = await fetch(`${config.apiUrl}/device-auth/${deviceCode}/status`, {
        headers: { Authorization: `Bearer ${deviceSecret}` },
      });
      if (res.ok) {
        const data: unknown = await res.json();

        if (!isJsonRecord(data) || typeof data.status !== 'string') {
          throw new InvalidDeviceAuthResponseError(
            'Authorization server returned an invalid status response',
          );
        }

        if (data.status === 'approved' && data.tunnelId && data.token) {
          const credentials = parseApprovedDeviceCredentials(data);
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${c.green}●${c.reset} ${c.bold}Authorized!${c.reset}`);
          console.log('');

          const enabledCapabilities = Array.isArray(data.capabilities)
            ? [...new Set(data.capabilities)].filter(
                (capability): capability is string =>
                  typeof capability === 'string' &&
                  ['filesystem', 'shell', 'desktop'].includes(capability),
              )
            : [];

          // Persist the browser-approved capabilities as a local ceiling. A
          // later server grant cannot silently enable another capability.
          saveCredentials(
            credentials.tunnelId,
            credentials.token,
            config.apiUrl,
            enabledCapabilities,
          );
          console.log(`  ${c.dim}Credentials saved to ${CONFIG_FILE}${c.reset}`);
          console.log(
            `  ${c.dim}Local capabilities: ${enabledCapabilities.join(', ') || 'none'}${c.reset}`,
          );
          console.log('');

          const mode = await chooseConnectMode(flags);
          if (mode.background) {
            installBackgroundService();
            return;
          }

          // Connect with received credentials
          const fullConfig = loadConfig({
            token: credentials.token,
            tunnelId: credentials.tunnelId,
            apiUrl: config.apiUrl,
          });
          startAgent(fullConfig);
          return;
        }

        if (data.status === 'approved') {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${c.red}✗${c.reset} Authorization was approved, but the setup token was not available.`);
          console.log(`  ${c.dim}Run the connect command again to create a fresh device authorization code.${c.reset}`);
          process.exit(1);
        }

        if (data.status === 'denied') {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${c.red}✗${c.reset} Authorization denied.`);
          process.exit(1);
        }

        if (data.status === 'expired') {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${c.red}✗${c.reset} Authorization expired. Please try again.`);
          process.exit(1);
        }
      }
    } catch (error) {
      if (error instanceof InvalidDeviceAuthResponseError) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        console.error(`  ${c.red}✗${c.reset} ${error.message}`);
        process.exit(1);
      }
    }

    await sleep(pollIntervalMs);
  }
}

async function commandConnect(flags: Record<string, string>): Promise<void> {
  const config = loadConfig({
    token: flags.token,
    tunnelId: flags['tunnel-id'],
    apiUrl: flags['api-url'],
  });

  // If both token and tunnelId are provided, connect directly
  if (config.token && config.tunnelId) {
    const mode = await chooseConnectMode(flags);
    if (mode.background) {
      saveCredentials(config.tunnelId, config.token, config.apiUrl);
      installBackgroundService();
      return;
    }
    startAgent(config);
    return;
  }

  // If neither is provided, use device auth flow
  if (!config.token && !config.tunnelId) {
    await commandConnectDeviceAuth(config, flags);
    return;
  }

  // Partial — error
  console.error(`${c.red}${c.bold} error${c.reset} Provide both --token and --tunnel-id, or neither (for device auth)`);
  process.exit(1);
}

async function commandRun(flags: Record<string, string>): Promise<void> {
  const config = loadConfig({
    token: flags.token,
    tunnelId: flags['tunnel-id'],
    apiUrl: flags['api-url'],
  });

  if (!config.token || !config.tunnelId) {
    console.error(`${c.red}${c.bold} error${c.reset} No saved tunnel credentials found. Run \`agent-tunnel connect\` first.`);
    process.exit(1);
  }

  startAgent(config, { service: flags.service === 'true' });
}

async function commandStatus(flags: Record<string, string>): Promise<void> {
  const config = loadConfig({
    token: flags.token,
    tunnelId: flags['tunnel-id'],
    apiUrl: flags['api-url'],
  });

  if (!config.token || !config.tunnelId) {
    console.error('Error: --token and --tunnel-id are required');
    process.exit(1);
  }

  if (isSetupTunnelToken(config.token)) {
    console.log(JSON.stringify({
      tunnelId: config.tunnelId,
      apiUrl: config.apiUrl,
      credential: 'device-setup-token',
      note: 'Saved device credentials authenticate the local WebSocket agent. HTTP live status requires a user or sandbox API key.',
      service: getServiceStatus(),
    }, null, 2));
    return;
  }

  try {
    const res = await fetch(`${config.apiUrl}/connections/${config.tunnelId}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });

    if (!res.ok) {
      console.error(`Error: ${res.status} ${await res.text()}`);
      process.exit(1);
    }

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

function commandInstallService(flags: Record<string, string>): void {
  const config = loadConfig({
    token: flags.token,
    tunnelId: flags['tunnel-id'],
    apiUrl: flags['api-url'],
  });

  if (!config.token || !config.tunnelId) {
    console.error(`${c.red}${c.bold} error${c.reset} No saved tunnel credentials found. Run \`agent-tunnel connect\` first, or pass --token and --tunnel-id.`);
    process.exit(1);
  }

  if (flags.token && flags['tunnel-id']) {
    saveCredentials(config.tunnelId, config.token, config.apiUrl);
  }

  const status = installService();
  console.log(JSON.stringify(status, null, 2));
}

function commandUninstallService(): void {
  console.log(JSON.stringify(uninstallService(), null, 2));
}

function commandStartService(): void {
  console.log(JSON.stringify(startService(), null, 2));
}

function commandStopService(): void {
  console.log(JSON.stringify(stopService(), null, 2));
}

function commandRestartService(): void {
  console.log(JSON.stringify(restartService(), null, 2));
}

function commandServiceStatus(): void {
  console.log(JSON.stringify(getServiceStatus(), null, 2));
}

function commandLogs(): void {
  const paths = getServicePaths();
  const files = [
    join(paths.logDir, 'agent-tunnel.out.log'),
    join(paths.logDir, 'agent-tunnel.err.log'),
  ];
  for (const file of files) {
    console.log(`\n${c.bold}${file}${c.reset}`);
    if (!existsSync(file)) {
      console.log(`${c.dim}not created yet${c.reset}`);
      continue;
    }
    const body = readFileSync(file, 'utf8');
    const lines = body.split(/\r?\n/).slice(-120).join('\n').trim();
    console.log(lines || `${c.dim}empty${c.reset}`);
  }
}

function showHelp(): void {
  console.log('');
  console.log(`  ${c.cyan}▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀${c.reset}   ${c.cyan}▀█▀ █ █ █▄ █ █▄ █ █▀▀ █  ${c.reset}`);
  console.log(`  ${c.cyan}█▀█ █▄█ ██▄ █ ▀█  █${c.reset}    ${c.cyan} █  █▄█ █ ▀█ █ ▀█ ██▄ █▄▄${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Secure bridge between AI agents & local machines${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Usage${c.reset}   ${c.dim}npx --yes @kortix/agent-tunnel@latest <command> [options]${c.reset}`);
  console.log('');
  console.log(`${c.gray}  ── Commands ────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.cyan}connect${c.reset}       Connect via device auth; interactively choose foreground/background`);
  console.log(`  ${c.cyan}run${c.reset}           Run using saved credentials ${c.dim}(used by service)${c.reset}`);
  console.log(`  ${c.cyan}install-service${c.reset} Install/start a persistent background service`);
  console.log(`  ${c.cyan}start${c.reset}         Start the installed background service`);
  console.log(`  ${c.cyan}stop${c.reset}          Stop the installed background service ${c.dim}(keeps it installed)${c.reset}`);
  console.log(`  ${c.cyan}restart${c.reset}       Restart the installed background service`);
  console.log(`  ${c.cyan}service-status${c.reset} Check persistent service status`);
  console.log(`  ${c.cyan}logs${c.reset}          Show recent service logs`);
  console.log(`  ${c.cyan}uninstall-service${c.reset} Stop/remove the persistent service`);
  console.log(`  ${c.cyan}status${c.reset}        Check tunnel connection status`);
  console.log(`  ${c.cyan}help${c.reset}          Show this help message`);
  console.log('');
  console.log(`${c.gray}  ── Options ─────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.white}--token${c.reset} ${c.dim}<token>${c.reset}       Skip device auth, connect directly`);
  console.log(`  ${c.white}--tunnel-id${c.reset} ${c.dim}<id>${c.reset}     Tunnel ID ${c.dim}(required with --token)${c.reset}`);
  console.log(`  ${c.white}--api-url${c.reset} ${c.dim}<url>${c.reset}       API URL ${c.dim}(default: http://localhost:8080)${c.reset}`);
  console.log(`  ${c.white}--daemon${c.reset}             With connect: skip the prompt and install the background service`);
  console.log(`  ${c.white}--foreground${c.reset}         With connect: skip prompts and run only in this terminal`);
  console.log('');
  console.log(`  ${c.dim}Config: ~/.agent-tunnel/config.json${c.reset}`);
  console.log(`  ${c.dim}powered by ${c.cyan}kortix${c.reset}`);
  console.log('');
}

const { command, flags } = parseArgs(process.argv);

if (Object.prototype.hasOwnProperty.call(flags, 'keep-awake')) {
  console.error(`${c.red}${c.bold} error${c.reset} --keep-awake is not supported. Configure sleep behavior in the operating system.`);
  process.exit(2);
}

switch (command) {
  case 'connect':
    commandConnect(flags);
    break;
  case 'run':
    commandRun(flags);
    break;
  case 'install-service':
    commandInstallService(flags);
    break;
  case 'start':
  case 'start-service':
    commandStartService();
    break;
  case 'stop':
  case 'stop-service':
  case 'disable':
    commandStopService();
    break;
  case 'restart':
  case 'restart-service':
    commandRestartService();
    break;
  case 'service-status':
    commandServiceStatus();
    break;
  case 'logs':
    commandLogs();
    break;
  case 'uninstall-service':
    commandUninstallService();
    break;
  case 'status':
    commandStatus(flags);
    break;
  case 'help':
  default:
    showHelp();
    break;
}
