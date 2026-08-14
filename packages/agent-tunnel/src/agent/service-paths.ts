import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const SERVICE_LABEL = 'ai.kortix.agent-tunnel';
export const DEFAULT_INSTALL_BACKGROUND_SERVICE = true;

/**
 * Exit code for conditions that restarting cannot fix: no saved credential, or
 * a credential the relay refuses. Every supervisor is configured to restart on
 * failure only, so a terminal condition ends the service instead of spinning.
 * Without this, a revoked token produces an endless respawn loop whose only
 * trace is a log file nobody reads.
 */
export const TERMINAL_SERVICE_EXIT_CODE = 0;

/** Supervised logs are appended to forever; launchd and systemd never rotate. */
export const MAX_SERVICE_LOG_BYTES = 5 * 1024 * 1024;
const RETAINED_LOG_LINES = 500;

export interface ServicePaths {
  configDir: string;
  logDir: string;
  binDir: string;
  vendoredRunner: string;
  launchdPlist: string;
  systemdUnit: string;
  windowsScript: string;
}

export function getServicePaths(): ServicePaths {
  const home = homedir();
  const configDir = join(home, '.agent-tunnel');
  const binDir = join(configDir, 'bin');
  return {
    configDir,
    logDir: join(configDir, 'logs'),
    binDir,
    vendoredRunner: join(binDir, 'agent-cli.js'),
    launchdPlist: join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    systemdUnit: join(home, '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`),
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
