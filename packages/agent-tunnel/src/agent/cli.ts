import '../node-ws-polyfill';
import { loadConfig, type TunnelConfig } from './config';
import { TunnelAgent } from './agent';
import { CapabilityRegistry } from './capabilities/index';
import { createFilesystemCapability } from './capabilities/filesystem';
import { createShellCapability } from './capabilities/shell';
import { createDesktopCapability } from './capabilities/desktop';
import { hostname, platform, arch } from 'os';
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

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

async function printStartup(config: { tunnelId: string; apiUrl: string }, version: string): Promise<void> {
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

function startAgent(config: TunnelConfig): void {
  const registry = new CapabilityRegistry();
  registry.register(createFilesystemCapability(config));
  registry.register(createShellCapability(config));
  registry.register(createDesktopCapability());

  clearScreen();
  printStartup(config, '0.1.2');

  const agent = new TunnelAgent(config, registry);
  agent.connect();

  const shutdown = () => {
    console.log(`\n${c.dim}  Shutting down…${c.reset}`);
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

function saveCredentials(tunnelId: string, token: string, apiUrl: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch {}
  let existing: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) {
    try { existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  }
  const tmpFile = join(CONFIG_DIR, `config.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify({ ...existing, tunnelId, token, apiUrl }, null, 2), { mode: 0o600, flag: 'wx' });
  try { chmodSync(tmpFile, 0o600); } catch {}
  renameSync(tmpFile, CONFIG_FILE);
  try { chmodSync(CONFIG_FILE, 0o600); } catch {}
}

async function commandConnectDeviceAuth(config: TunnelConfig): Promise<void> {
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
    const data = await res.json();
    deviceCode = data.deviceCode;
    deviceSecret = data.deviceSecret;
    verificationUrl = data.verificationUrl;
    expiresAt = data.expiresAt;
    pollIntervalMs = data.pollIntervalMs || 2000;
  } catch (err) {
    console.error(`  ${c.red}✗${c.reset} Failed to reach API at ${config.apiUrl}`);
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
        const data = await res.json();

        if (data.status === 'approved' && data.tunnelId && data.token) {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          console.log(`  ${c.green}●${c.reset} ${c.bold}Authorized!${c.reset}`);
          console.log('');

          // Save credentials
          saveCredentials(data.tunnelId, data.token, config.apiUrl);
          console.log(`  ${c.dim}Credentials saved to ${CONFIG_FILE}${c.reset}`);
          console.log('');

          // Connect with received credentials
          const fullConfig = loadConfig({
            token: data.token,
            tunnelId: data.tunnelId,
            apiUrl: config.apiUrl,
          });
          startAgent(fullConfig);
          return;
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
    } catch {}

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
    startAgent(config);
    return;
  }

  // If neither is provided, use device auth flow
  if (!config.token && !config.tunnelId) {
    await commandConnectDeviceAuth(config);
    return;
  }

  // Partial — error
  console.error(`${c.red}${c.bold} error${c.reset} Provide both --token and --tunnel-id, or neither (for device auth)`);
  process.exit(1);
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

function showHelp(): void {
  console.log('');
  console.log(`  ${c.cyan}▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀${c.reset}   ${c.cyan}▀█▀ █ █ █▄ █ █▄ █ █▀▀ █  ${c.reset}`);
  console.log(`  ${c.cyan}█▀█ █▄█ ██▄ █ ▀█  █${c.reset}    ${c.cyan} █  █▄█ █ ▀█ █ ▀█ ██▄ █▄▄${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Secure bridge between AI agents & local machines${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Usage${c.reset}   ${c.dim}npx @kortix/agent-tunnel <command> [options]${c.reset}`);
  console.log('');
  console.log(`${c.gray}  ── Commands ────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.cyan}connect${c.reset}       Connect via device auth (opens browser)`);
  console.log(`  ${c.cyan}status${c.reset}        Check tunnel connection status`);
  console.log(`  ${c.cyan}help${c.reset}          Show this help message`);
  console.log('');
  console.log(`${c.gray}  ── Options ─────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.white}--token${c.reset} ${c.dim}<token>${c.reset}       Skip device auth, connect directly`);
  console.log(`  ${c.white}--tunnel-id${c.reset} ${c.dim}<id>${c.reset}     Tunnel ID ${c.dim}(required with --token)${c.reset}`);
  console.log(`  ${c.white}--api-url${c.reset} ${c.dim}<url>${c.reset}       API URL ${c.dim}(default: http://localhost:8080)${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Config: ~/.agent-tunnel/config.json${c.reset}`);
  console.log(`  ${c.dim}powered by ${c.cyan}kortix${c.reset}`);
  console.log('');
}

const { command, flags } = parseArgs(process.argv);

switch (command) {
  case 'connect':
    commandConnect(flags);
    break;
  case 'status':
    commandStatus(flags);
    break;
  case 'help':
  default:
    showHelp();
    break;
}
