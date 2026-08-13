import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, platform, userInfo } from 'os';
import { dirname, join } from 'path';
import { powershellQuote, shellQuote, xmlEscape } from './service-quoting';
import type { ServicePaths } from './service-paths';
import { SERVICE_LABEL, TERMINAL_SERVICE_EXIT_CODE, getServicePaths } from './service-paths';

/**
 * One driver per supervisor.
 *
 * These six operations used to be six exported functions, each with the same
 * three-way `platform()` chain and its own "not supported" throw — fifteen
 * branches expressing one dispatch. The table below is that dispatch, so adding
 * or fixing a platform touches one object instead of six functions.
 */
export interface ServiceDriver {
  /** File that proves the service is installed, and is shown to the user. */
  unitPath(paths: ServicePaths): string;
  install(paths: ServicePaths, runner: RunnerParts): Outcome;
  uninstall(paths: ServicePaths): Outcome;
  start(paths: ServicePaths, installed: boolean): Outcome;
  stop(paths: ServicePaths, installed: boolean): Outcome;
  status(paths: ServicePaths, installed: boolean): Outcome;
}

/** The interpreter plus arguments the supervisor must launch. */
export interface RunnerParts {
  command: string;
  args: string[];
}

/**
 * Resolves the interpreter at start rather than baking one absolute path in.
 * A version-managed Node (nvm, fnm, volta) moves when the user upgrades, which
 * would otherwise strand the service.
 */
export function posixShellCommand(runner: RunnerParts): string {
  const interpreter = `"$(command -v ${shellQuote(runner.command)} 2>/dev/null || command -v node)"`;
  return `exec ${interpreter} ${runner.args.map(shellQuote).join(' ')}`;
}

export interface Outcome {
  /** `null` means "requested, but the supervisor did not confirm". */
  active?: boolean | null;
  installed?: boolean;
  detail?: string;
}

interface CommandResult {
  ok: boolean;
  detail: string;
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    detail: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
  };
}

const notInstalled = (what: string): CommandResult => ({ ok: false, detail: `${what} is not installed.` });

function joinDetails(...results: CommandResult[]): string {
  return results.map((result) => result.detail).filter(Boolean).join('\n');
}

function launchdTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  return `gui/${uid}`;
}

// ── templates ────────────────────────────────────────────────────────────────

function logPaths(paths: ServicePaths): { stdout: string; stderr: string } {
  return {
    stdout: join(paths.logDir, 'agent-tunnel.out.log'),
    stderr: join(paths.logDir, 'agent-tunnel.err.log'),
  };
}

export function renderLaunchdPlist(command: string, paths: ServicePaths = getServicePaths()): string {
  const { stdout, stderr } = logPaths(paths);
  // KeepAlive is conditional: a clean exit means the agent stopped for a reason
  // restarting cannot fix, such as a missing or revoked credential.
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
  const { stdout, stderr } = logPaths(paths);
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

export function renderWindowsPowerShellScript(runner: { command: string; args: string[] }): string {
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

// ── drivers ──────────────────────────────────────────────────────────────────

const launchd: ServiceDriver = {
  unitPath: (paths) => paths.launchdPlist,

  install(paths, runner) {
    mkdirSync(dirname(paths.launchdPlist), { recursive: true });
    writeFileSync(paths.launchdPlist, renderLaunchdPlist(posixShellCommand(runner), paths), { mode: 0o600 });
    run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    const boot = run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist]);
    const kick = run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${SERVICE_LABEL}`]);
    return { installed: true, active: boot.ok || kick.ok ? true : null, detail: joinDetails(boot, kick) };
  },

  uninstall(paths) {
    const existed = existsSync(paths.launchdPlist);
    const stop = run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    if (existed) rmSync(paths.launchdPlist, { force: true });
    return { detail: stop.detail };
  },

  start(paths, installed) {
    const boot = installed
      ? run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist])
      : notInstalled('LaunchAgent');
    const kick = run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${SERVICE_LABEL}`]);
    return { active: boot.ok || kick.ok ? true : null, detail: joinDetails(boot, kick) };
  },

  stop(paths, installed) {
    const stop = installed
      ? run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist])
      : notInstalled('LaunchAgent');
    return { detail: stop.detail };
  },

  status(paths, installed) {
    const status = run('launchctl', ['print', `${launchdTarget()}/${SERVICE_LABEL}`]);
    return {
      active: status.ok,
      detail: status.detail || (installed ? readFileSync(paths.launchdPlist, 'utf8') : undefined),
    };
  },
};

const systemd: ServiceDriver = {
  unitPath: (paths) => paths.systemdUnit,

  install(paths, runner) {
    mkdirSync(dirname(paths.systemdUnit), { recursive: true });
    writeFileSync(paths.systemdUnit, renderSystemdUnit(posixShellCommand(runner), paths), { mode: 0o600 });
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    const enable = run('systemctl', ['--user', 'enable', '--now', `${SERVICE_LABEL}.service`]);
    return { installed: true, active: enable.ok ? true : null, detail: joinDetails(reload, enable) };
  },

  uninstall(paths) {
    const existed = existsSync(paths.systemdUnit);
    const disable = run('systemctl', ['--user', 'disable', '--now', `${SERVICE_LABEL}.service`]);
    if (existed) rmSync(paths.systemdUnit, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    return { detail: disable.detail };
  },

  start(_paths, installed) {
    const start = installed
      ? run('systemctl', ['--user', 'start', `${SERVICE_LABEL}.service`])
      : notInstalled('systemd unit');
    return { active: start.ok ? true : null, detail: start.detail };
  },

  stop(_paths, installed) {
    const stop = installed
      ? run('systemctl', ['--user', 'stop', `${SERVICE_LABEL}.service`])
      : notInstalled('systemd unit');
    return { detail: stop.detail };
  },

  status() {
    const status = run('systemctl', ['--user', 'is-active', `${SERVICE_LABEL}.service`]);
    return { active: status.ok, detail: status.detail };
  },
};

const scheduledTask: ServiceDriver = {
  unitPath: (paths) => paths.windowsScript,

  install(paths, runner) {
    writeFileSync(paths.windowsScript, renderWindowsPowerShellScript(runner), { mode: 0o600 });
    const create = run('schtasks.exe', [
      '/Create', '/TN', SERVICE_LABEL,
      '/TR', `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${paths.windowsScript}"`,
      '/SC', 'ONLOGON', '/F', '/RL', 'LIMITED',
    ]);
    const start = run('schtasks.exe', ['/Run', '/TN', SERVICE_LABEL]);
    return { installed: create.ok, active: start.ok ? true : null, detail: joinDetails(create, start) };
  },

  uninstall(paths) {
    const existed = existsSync(paths.windowsScript);
    const stop = run('schtasks.exe', ['/End', '/TN', SERVICE_LABEL]);
    const del = run('schtasks.exe', ['/Delete', '/TN', SERVICE_LABEL, '/F']);
    if (existed) rmSync(paths.windowsScript, { force: true });
    return { detail: joinDetails(stop, del) };
  },

  start(_paths, installed) {
    const start = installed
      ? run('schtasks.exe', ['/Run', '/TN', SERVICE_LABEL])
      : notInstalled('Scheduled Task');
    return { active: start.ok ? true : null, detail: start.detail };
  },

  stop(_paths, installed) {
    const stop = installed
      ? run('schtasks.exe', ['/End', '/TN', SERVICE_LABEL])
      : notInstalled('Scheduled Task');
    return { detail: stop.detail };
  },

  status(paths, installed) {
    const status = run('schtasks.exe', ['/Query', '/TN', SERVICE_LABEL, '/FO', 'LIST', '/V']);
    const detail = status.detail || (installed ? readFileSync(paths.windowsScript, 'utf8') : undefined);
    return { active: status.ok ? /Status:\s*Running/i.test(detail ?? '') : false, detail };
  },
};

const DRIVERS: Partial<Record<NodeJS.Platform, ServiceDriver>> = {
  darwin: launchd,
  linux: systemd,
  win32: scheduledTask,
};

export const SUPPORTED_PLATFORMS_MESSAGE =
  'Background services are supported on macOS launchd, Linux systemd user services, and Windows Scheduled Tasks.';

export function serviceDriver(): ServiceDriver | undefined {
  return DRIVERS[platform()];
}
