import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  shellEnvPassthrough: ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'NODE_ENV', 'HOSTNAME'],
};

export function loadConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  let fileConfig: Partial<TunnelConfig> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (err) {
      console.warn(`[config] Failed to parse ${CONFIG_FILE}:`, err);
    }
  }

  const envConfig: Partial<TunnelConfig> = {};
  if (process.env.TUNNEL_TOKEN) envConfig.token = process.env.TUNNEL_TOKEN;
  if (process.env.TUNNEL_ID) envConfig.tunnelId = process.env.TUNNEL_ID;
  if (process.env.TUNNEL_API_URL) envConfig.apiUrl = process.env.TUNNEL_API_URL;
  if (process.env.TUNNEL_WS_PATH) envConfig.wsPath = process.env.TUNNEL_WS_PATH;
  if (process.env.TUNNEL_MAX_FILE_SIZE) envConfig.maxFileSize = parseInt(process.env.TUNNEL_MAX_FILE_SIZE, 10);

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...overrides,
  } as TunnelConfig;

  return merged;
}
