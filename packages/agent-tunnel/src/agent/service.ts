import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, platform, userInfo } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

export const SERVICE_LABEL = 'ai.kortix.agent-tunnel';
export const DEFAULT_INSTALL_BACKGROUND_SERVICE = true;

/**
 * Exit code for conditions that restarting cannot fix: no saved credential, or
 * a credential the relay refuses. Every supervisor below is configured to stop
 * on a clean exit and restart only on a failure exit, so a terminal condition
 * ends the service instead of spinning. Without this, a revoked token produces
 * an endless respawn loop whose only trace is a log file nobody reads.
 */
export const TERMINAL_SERVICE_EXIT_CODE = 0;

export interface ServicePaths {
  configDir: string;
  logDir: string;
  binDir: string;
  vendoredRunner: string;
  launchdPlist: string;
  systemdUnit: string;
  windowsScript: string;
}

export interface ServiceStatus {
  platform: NodeJS.Platform;
  installed: boolean;
  active: boolean | null;
  path?: string;
  detail?: string;
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

/**
 * True for locations that the package manager may delete without warning.
 *
 * `npx` extracts the package into a content-addressed cache directory and
 * garbage-collects it. A background service pointed at that path starts fine
 * and then dies permanently the first time the cache is pruned, with only a
 * MODULE_NOT_FOUND in a log file nobody reads.
 */
export function isEphemeralRunnerPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.includes('/_npx/') ||
    normalized.includes('/_cacache/') ||
    normalized.includes('/.pnpm-store/') ||
    normalized.includes('/.yarn/$$virtual/')
  );
}

/**
 * Copies the running CLI bundle into ~/.agent-tunnel/bin so the installed
 * service owns its executable. The bundle is a single self-contained file that
 * imports only Node builtins, so a plain copy is sufficient.
 *
 * Returns the path the service should execute.
 */
export function vendorRunner(scriptPath: string, paths: ServicePaths = getServicePaths()): string {
  if (!isEphemeralRunnerPath(scriptPath)) return scriptPath;

  mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  const source = realpathSync(scriptPath);
  copyFileSync(source, paths.vendoredRunner);
  try { chmodSync(paths.vendoredRunner, 0o700); } catch {}
  writeFileSync(
    join(paths.binDir, 'agent-cli.source.json'),
    JSON.stringify({ source, vendoredFrom: scriptPath }, null, 2),
    { mode: 0o600 },
  );
  return paths.vendoredRunner;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function currentRunnerParts(): { command: string; args: string[] } {
  const exec = process.execPath;
  const script = process.argv[1];
  if (script && existsSync(script)) {
    return { command: exec, args: [vendorRunner(script), 'run', '--service'] };
  }
  throw new Error(
    'Cannot install the background service because the current Agent Tunnel executable was not found',
  );
}

/**
 * Resolves the interpreter at service start rather than baking one absolute
 * path in. A version-managed Node (nvm, fnm, volta) moves when the user
 * upgrades, which would otherwise strand the service the same way an evicted
 * npx cache does.
 */
function resolveInterpreterExpression(execPath: string): string {
  return `"$(command -v ${shellQuote(execPath)} 2>/dev/null || command -v node)"`;
}

function currentRunnerCommand(): string {
  const runner = currentRunnerParts();
  const args = runner.args.map(shellQuote).join(' ');
  return `${resolveInterpreterExpression(runner.command)} ${args}`;
}

export function buildServiceShellCommand(): string {
  return `exec ${currentRunnerCommand()}`;
}

export function renderWindowsPowerShellScript(
  runner = currentRunnerParts(),
): string {
  const command = powershellQuote(runner.command);
  const args = runner.args.map(powershellQuote).join(' ');

  return `$ErrorActionPreference = 'Continue'
while ($true) {
  & ${command}${args ? ` ${args}` : ''}
  # A clean exit means the agent stopped for a reason restarting cannot fix,
  # such as a missing or revoked credential. Anything else is a crash worth retrying.
  if ($LASTEXITCODE -eq ${TERMINAL_SERVICE_EXIT_CODE}) { break }
  Start-Sleep -Seconds 5
}
`;
}

function windowsTaskCommand(paths: ServicePaths): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${paths.windowsScript}"`;
}

export function renderLaunchdPlist(command: string, paths: ServicePaths = getServicePaths()): string {
  const stdout = join(paths.logDir, 'agent-tunnel.out.log');
  const stderr = join(paths.logDir, 'agent-tunnel.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit(command: string, paths: ServicePaths = getServicePaths()): string {
  const stdout = join(paths.logDir, 'agent-tunnel.out.log');
  const stderr = join(paths.logDir, 'agent-tunnel.err.log');
  return `[Unit]
Description=Kortix Agent Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
UMask=0077
ExecStart=/bin/sh -lc ${shellQuote(command)}
Restart=on-failure
RestartSec=5
WorkingDirectory=${homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${stdout}
StandardError=append:${stderr}

[Install]
WantedBy=default.target
`;
}

/** Keep supervised logs bounded. launchd and systemd append without rotating. */
export const MAX_SERVICE_LOG_BYTES = 5 * 1024 * 1024;
const RETAINED_LOG_LINES = 500;

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
      if (!existsSync(file) || statSync(file).size <= maxBytes) continue;
      const kept = readFileSync(file, 'utf8').split(/\r?\n/).slice(-RETAINED_LOG_LINES).join('\n');
      writeFileSync(file, `[agent-tunnel] earlier entries trimmed\n${kept}`, { mode: 0o600 });
      rotated.push(file);
    } catch {
      // A log we cannot rewrite must never stop the service from starting.
    }
  }
  return rotated;
}

function run(command: string, args: string[]): { ok: boolean; detail: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { ok: result.status === 0, detail };
}

function launchdTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  return `gui/${uid}`;
}

export function installService(): ServiceStatus {
  const paths = getServicePaths();
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  rotateServiceLogs(paths);

  const command = buildServiceShellCommand();

  if (platform() === 'darwin') {
    mkdirSync(dirname(paths.launchdPlist), { recursive: true });
    writeFileSync(paths.launchdPlist, renderLaunchdPlist(command, paths), { mode: 0o600 });
    run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    const boot = run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist]);
    const kick = run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${SERVICE_LABEL}`]);
    return {
      platform: platform(),
      installed: true,
      active: boot.ok || kick.ok ? true : null,
      path: paths.launchdPlist,
      detail: [boot.detail, kick.detail].filter(Boolean).join('\n'),
    };
  }

  if (platform() === 'linux') {
    mkdirSync(dirname(paths.systemdUnit), { recursive: true });
    writeFileSync(paths.systemdUnit, renderSystemdUnit(command, paths), { mode: 0o600 });
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    const enable = run('systemctl', ['--user', 'enable', '--now', `${SERVICE_LABEL}.service`]);
    return {
      platform: platform(),
      installed: true,
      active: enable.ok ? true : null,
      path: paths.systemdUnit,
      detail: [reload.detail, enable.detail].filter(Boolean).join('\n'),
    };
  }

  if (platform() === 'win32') {
    writeFileSync(paths.windowsScript, renderWindowsPowerShellScript(), { mode: 0o600 });
    const create = run('schtasks.exe', [
      '/Create',
      '/TN',
      SERVICE_LABEL,
      '/TR',
      windowsTaskCommand(paths),
      '/SC',
      'ONLOGON',
      '/F',
      '/RL',
      'LIMITED',
    ]);
    const start = run('schtasks.exe', ['/Run', '/TN', SERVICE_LABEL]);
    return {
      platform: platform(),
      installed: create.ok,
      active: start.ok ? true : null,
      path: paths.windowsScript,
      detail: [create.detail, start.detail].filter(Boolean).join('\n'),
    };
  }

  throw new Error('Background service install is currently supported on macOS launchd, Linux systemd user services, and Windows Scheduled Tasks.');
}

export function uninstallService(): ServiceStatus {
  const paths = getServicePaths();
  // Remove the vendored executable too, so uninstall leaves no residue that a
  // later install would silently reuse.
  rmSync(paths.binDir, { recursive: true, force: true });

  if (platform() === 'darwin') {
    const existed = existsSync(paths.launchdPlist);
    const stop = run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    if (existed) rmSync(paths.launchdPlist, { force: true });
    return {
      platform: platform(),
      installed: false,
      active: false,
      path: paths.launchdPlist,
      detail: stop.detail,
    };
  }

  if (platform() === 'linux') {
    const existed = existsSync(paths.systemdUnit);
    const disable = run('systemctl', ['--user', 'disable', '--now', `${SERVICE_LABEL}.service`]);
    if (existed) rmSync(paths.systemdUnit, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    return {
      platform: platform(),
      installed: false,
      active: false,
      path: paths.systemdUnit,
      detail: disable.detail,
    };
  }

  if (platform() === 'win32') {
    const existed = existsSync(paths.windowsScript);
    const stop = run('schtasks.exe', ['/End', '/TN', SERVICE_LABEL]);
    const del = run('schtasks.exe', ['/Delete', '/TN', SERVICE_LABEL, '/F']);
    if (existed) rmSync(paths.windowsScript, { force: true });
    return {
      platform: platform(),
      installed: false,
      active: false,
      path: paths.windowsScript,
      detail: [stop.detail, del.detail].filter(Boolean).join('\n'),
    };
  }

  throw new Error('Background service uninstall is currently supported on macOS launchd, Linux systemd user services, and Windows Scheduled Tasks.');
}

export function startService(): ServiceStatus {
  const paths = getServicePaths();

  if (platform() === 'darwin') {
    const installed = existsSync(paths.launchdPlist);
    const boot = installed ? run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist]) : { ok: false, detail: 'LaunchAgent is not installed.' };
    const kick = run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${SERVICE_LABEL}`]);
    return {
      platform: platform(),
      installed,
      active: boot.ok || kick.ok ? true : null,
      path: paths.launchdPlist,
      detail: [boot.detail, kick.detail].filter(Boolean).join('\n'),
    };
  }

  if (platform() === 'linux') {
    const installed = existsSync(paths.systemdUnit);
    const start = installed ? run('systemctl', ['--user', 'start', `${SERVICE_LABEL}.service`]) : { ok: false, detail: 'systemd unit is not installed.' };
    return {
      platform: platform(),
      installed,
      active: start.ok ? true : null,
      path: paths.systemdUnit,
      detail: start.detail,
    };
  }

  if (platform() === 'win32') {
    const installed = existsSync(paths.windowsScript);
    const start = installed ? run('schtasks.exe', ['/Run', '/TN', SERVICE_LABEL]) : { ok: false, detail: 'Scheduled Task is not installed.' };
    return {
      platform: platform(),
      installed,
      active: start.ok ? true : null,
      path: paths.windowsScript,
      detail: start.detail,
    };
  }

  throw new Error('Background service start is currently supported on macOS, Linux, and Windows.');
}

export function stopService(): ServiceStatus {
  const paths = getServicePaths();

  if (platform() === 'darwin') {
    const installed = existsSync(paths.launchdPlist);
    const stop = installed ? run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]) : { ok: false, detail: 'LaunchAgent is not installed.' };
    return {
      platform: platform(),
      installed,
      active: false,
      path: paths.launchdPlist,
      detail: stop.detail,
    };
  }

  if (platform() === 'linux') {
    const installed = existsSync(paths.systemdUnit);
    const stop = installed ? run('systemctl', ['--user', 'stop', `${SERVICE_LABEL}.service`]) : { ok: false, detail: 'systemd unit is not installed.' };
    return {
      platform: platform(),
      installed,
      active: false,
      path: paths.systemdUnit,
      detail: stop.detail,
    };
  }

  if (platform() === 'win32') {
    const installed = existsSync(paths.windowsScript);
    const stop = installed ? run('schtasks.exe', ['/End', '/TN', SERVICE_LABEL]) : { ok: false, detail: 'Scheduled Task is not installed.' };
    return {
      platform: platform(),
      installed,
      active: false,
      path: paths.windowsScript,
      detail: stop.detail,
    };
  }

  throw new Error('Background service stop is currently supported on macOS, Linux, and Windows.');
}

export function restartService(): ServiceStatus {
  stopService();
  return startService();
}

export function getServiceStatus(): ServiceStatus {
  const paths = getServicePaths();

  if (platform() === 'darwin') {
    const installed = existsSync(paths.launchdPlist);
    const status = run('launchctl', ['print', `${launchdTarget()}/${SERVICE_LABEL}`]);
    return {
      platform: platform(),
      installed,
      active: status.ok,
      path: paths.launchdPlist,
      detail: status.detail || (installed ? readFileSync(paths.launchdPlist, 'utf8') : undefined),
    };
  }

  if (platform() === 'linux') {
    const installed = existsSync(paths.systemdUnit);
    const status = run('systemctl', ['--user', 'is-active', `${SERVICE_LABEL}.service`]);
    return {
      platform: platform(),
      installed,
      active: status.ok,
      path: paths.systemdUnit,
      detail: status.detail,
    };
  }

  if (platform() === 'win32') {
    const installed = existsSync(paths.windowsScript);
    const status = run('schtasks.exe', ['/Query', '/TN', SERVICE_LABEL, '/FO', 'LIST', '/V']);
    const detail = status.detail || (installed ? readFileSync(paths.windowsScript, 'utf8') : undefined);
    return {
      platform: platform(),
      installed,
      active: status.ok ? /Status:\s*Running/i.test(detail ?? '') : false,
      path: paths.windowsScript,
      detail,
    };
  }

  return {
    platform: platform(),
    installed: false,
    active: null,
    detail: 'Background service status is currently supported on macOS launchd, Linux systemd user services, and Windows Scheduled Tasks.',
  };
}
