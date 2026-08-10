import { chmodSync, existsSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isTunnelCapability } from '../shared/permissions';
import type { TunnelCapability } from '../shared/types';

export interface TunnelConfig {
  token: string;
  tunnelId: string;
  apiUrl: string;
  wsPath: string;
  maxFileSize: number;
  allowedPaths: string[];
  allowedCommands: string[];
  blockedCommands: string[];
  blockedPaths: string[];
  workingDir: string;
  shellTimeout: number;
  shellMaxTimeout: number;
  shellMaxOutputSize: number;
  shellEnvPassthrough: string[];
  /** Local maximum. An API permission cannot enable a capability outside this set. */
  enabledCapabilities?: TunnelCapability[];
}

const CONFIG_DIR = join(homedir(), '.agent-tunnel');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULTS: Partial<TunnelConfig> = {
  apiUrl: 'http://localhost:8080',
  wsPath: '/ws',
  maxFileSize: 10 * 1024 * 1024,
  allowedPaths: [homedir()],
  allowedCommands: [],
  blockedCommands: [],
  blockedPaths: [
    '/etc/shadow',
    '/etc/passwd',
    '/etc/sudoers',
    '/etc/ssh',
    '/root/.ssh',
    '/proc',
    '/sys',
    '/dev',
  ],
  workingDir: homedir(),
  shellTimeout: 30_000,
  shellMaxTimeout: 120_000,
  shellMaxOutputSize: 1024 * 1024,
  shellEnvPassthrough: [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'NODE_ENV',
    'HOSTNAME',
  ],
  // Compatibility for existing configs. New device-auth connections persist
  // the exact capability set that the user approved in the browser.
  enabledCapabilities: ['filesystem', 'shell', 'desktop'],
};

function compactConfig(input: Partial<TunnelConfig>): Partial<TunnelConfig> {
  const output: Partial<TunnelConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (output as Record<string, unknown>)[key] = value;
    }
  }
  return output;
}

function assertPrivateOwnedPath(
  path: string,
  kind: 'directory' | 'file',
  expectedMode: number,
): void {
  const stats = lstatSync(path);
  const validType = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !validType) {
    throw new Error(`Tunnel config ${kind} must be a regular ${kind}, not a symlink`);
  }
  if (
    typeof process.getuid === 'function' &&
    typeof stats.uid === 'number' &&
    stats.uid !== process.getuid()
  ) {
    throw new Error(`Tunnel config ${kind} is not owned by the current user`);
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, expectedMode);
    } catch (error) {
      throw new Error(
        `Cannot secure tunnel config ${kind}: ${error instanceof Error ? error.message : error}`,
      );
    }
    const secured = lstatSync(path);
    if ((secured.mode & 0o077) !== 0) {
      throw new Error(`Tunnel config ${kind} permissions are not private`);
    }
  }
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Tunnel config ${name} must be an array of strings`);
  }
}

function validateConfigValues(config: TunnelConfig): void {
  assertStringArray(config.allowedPaths, 'allowedPaths');
  assertStringArray(config.allowedCommands, 'allowedCommands');
  assertStringArray(config.blockedCommands, 'blockedCommands');
  assertStringArray(config.blockedPaths, 'blockedPaths');
  assertStringArray(config.shellEnvPassthrough, 'shellEnvPassthrough');
  if (config.enabledCapabilities !== undefined) {
    assertStringArray(config.enabledCapabilities, 'enabledCapabilities');
    if (
      new Set(config.enabledCapabilities).size !== config.enabledCapabilities.length ||
      !config.enabledCapabilities.every(isTunnelCapability)
    ) {
      throw new Error(
        'Tunnel config enabledCapabilities must contain unique supported capabilities',
      );
    }
  }

  for (const [name, value] of [
    ['maxFileSize', config.maxFileSize],
    ['shellTimeout', config.shellTimeout],
    ['shellMaxTimeout', config.shellMaxTimeout],
    ['shellMaxOutputSize', config.shellMaxOutputSize],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Tunnel config ${name} must be a positive safe integer`);
    }
  }
  if (typeof config.workingDir !== 'string' || config.workingDir.length === 0) {
    throw new Error('Tunnel config workingDir must be a non-empty string');
  }
}

export function trustedCredential(value: string, name: string): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`Invalid tunnel ${name}`);
  }
  return value;
}

export function trustedHttpUrl(value: string): string {
  const raw = trustedCredential(value, 'apiUrl');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Tunnel API URL must use http or https');
  }
  assertEncryptedOrLoopback(url);
  return url.toString().replace(/\/$/, '');
}

function assertEncryptedOrLoopback(url: URL): void {
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Remote tunnel API URLs must use https');
  }
}

export function normalizeApiUrl(value: string): string {
  const raw = trustedCredential(value, 'apiUrl');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid tunnel API URL protocol');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid tunnel API URL protocol');
  }
  assertEncryptedOrLoopback(url);
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

export function absoluteWsPath(value: string): string {
  if (!value.startsWith('/')) {
    throw new Error('Tunnel WebSocket path must be an absolute path');
  }
  return value;
}

export function loadConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  let fileConfig: Partial<TunnelConfig> = {};
  if (existsSync(CONFIG_FILE)) {
    if (!existsSync(CONFIG_DIR)) throw new Error('Tunnel config directory is missing');
    assertPrivateOwnedPath(CONFIG_DIR, 'directory', 0o700);
    assertPrivateOwnedPath(CONFIG_FILE, 'file', 0o600);
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('root value must be an object');
      }
      fileConfig = parsed;
    } catch (err) {
      throw new Error(
        `Tunnel config is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const envConfig: Partial<TunnelConfig> = {};
  if (process.env.TUNNEL_TOKEN) envConfig.token = process.env.TUNNEL_TOKEN;
  if (process.env.TUNNEL_ID) envConfig.tunnelId = process.env.TUNNEL_ID;
  if (process.env.TUNNEL_API_URL) envConfig.apiUrl = process.env.TUNNEL_API_URL;
  if (process.env.TUNNEL_WS_PATH) envConfig.wsPath = process.env.TUNNEL_WS_PATH;
  if (process.env.TUNNEL_MAX_FILE_SIZE)
    envConfig.maxFileSize = parseInt(process.env.TUNNEL_MAX_FILE_SIZE, 10);

  const merged = {
    ...DEFAULTS,
    ...compactConfig(fileConfig),
    ...envConfig,
    ...compactConfig(overrides),
  } as TunnelConfig;

  merged.apiUrl = normalizeApiUrl(merged.apiUrl);
  merged.wsPath = absoluteWsPath(merged.wsPath);
  validateConfigValues(merged);

  return merged;
}
