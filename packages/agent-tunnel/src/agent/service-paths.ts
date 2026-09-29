import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** Label of the default service. A non-default AGENT_TUNNEL_HOME gets a suffixed one. */
export const SERVICE_LABEL = 'ai.kortix.agent-tunnel';

export function defaultAgentTunnelHome(): string {
  return join(homedir(), '.agent-tunnel');
}

/**
 * Config directory: `AGENT_TUNNEL_HOME`, else `~/.agent-tunnel`. The override
 * lets a desktop dev build or a test pair a second identity on one machine
 * without touching the real one.
 */
export function agentTunnelHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_TUNNEL_HOME?.trim();
  return override ? resolve(override) : defaultAgentTunnelHome();
}

/**
 * The default home keeps the historical label, so existing installs keep
 * managing the service they already have. Any other home gets a stable suffix
 * from its path, so its service never replaces the real one.
 */
export function serviceLabelFor(home: string): string {
  const dir = resolve(home);
  if (dir === defaultAgentTunnelHome()) return SERVICE_LABEL;
  return `${SERVICE_LABEL}.${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

/** Environment the supervised process needs to find the same home again. */
export function serviceHomeEnv(home: string = agentTunnelHome()): Record<string, string> {
  return resolve(home) === defaultAgentTunnelHome() ? {} : { AGENT_TUNNEL_HOME: resolve(home) };
}
export const DEFAULT_INSTALL_BACKGROUND_SERVICE = true;

/**
 * Kept for 0.1.x importers only. Since contract v2 (R2) a service never exits
 * on its own and every supervisor restarts on any exit, so nothing uses it.
 */
export const TERMINAL_SERVICE_EXIT_CODE = 0;

/** Supervised logs are appended to forever; launchd and systemd never rotate. */
export const MAX_SERVICE_LOG_BYTES = 5 * 1024 * 1024;
const RETAINED_LOG_LINES = 500;

export interface ServicePaths {
  /** launchd label, systemd unit stem, and Scheduled Task name. */
  label: string;
  configDir: string;
  logDir: string;
  binDir: string;
  vendoredRunner: string;
  launchdPlist: string;
  systemdUnit: string;
  windowsScript: string;
}

export function getServicePaths(configDir: string = agentTunnelHome()): ServicePaths {
  const home = homedir();
  const label = serviceLabelFor(configDir);
  const binDir = join(configDir, 'bin');
  return {
    label,
    configDir,
    logDir: join(configDir, 'logs'),
    binDir,
    vendoredRunner: join(binDir, 'agent-cli.js'),
    launchdPlist: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    systemdUnit: join(home, '.config', 'systemd', 'user', `${label}.service`),
    windowsScript: join(configDir, 'agent-tunnel-service.ps1'),
  };
}

export function serviceLogFiles(paths: ServicePaths = getServicePaths()): string[] {
  return [
    join(paths.logDir, 'agent-tunnel.out.log'),
    join(paths.logDir, 'agent-tunnel.err.log'),
  ];
}

/**
 * Trims oversized log files in place, keeping the most recent lines.
 *
 * A restart loop can produce megabytes of identical lines — 23 MB was observed
 * on a real machine. Supervisors hold these files open in append mode, so
 * rewriting the contents is safe while the service runs.
 */
export function rotateServiceLogs(
  paths: ServicePaths = getServicePaths(),
  maxBytes = MAX_SERVICE_LOG_BYTES,
): string[] {
  const rotated: string[] = [];
  for (const file of serviceLogFiles(paths)) {
    try {
      // Read once and decide from the bytes in hand. Checking existence or size
      // first and then reading is a race: the supervisor appends continuously,
      // so the file examined need not be the file read.
      const contents = readFileSync(file, 'utf8');
      if (Buffer.byteLength(contents, 'utf8') <= maxBytes) continue;
      const kept = contents.split(/\r?\n/).slice(-RETAINED_LOG_LINES).join('\n');
      writeFileSync(file, `[agent-tunnel] earlier entries trimmed\n${kept}`, { mode: 0o600 });
      rotated.push(file);
    } catch {
      // A missing or unreadable log must never stop the service from starting.
    }
  }
  return rotated;
}
