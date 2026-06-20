import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, platform, userInfo } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

export const SERVICE_LABEL = 'ai.kortix.agent-tunnel';

export interface ServiceInstallOptions {
  keepAwake?: boolean;
}

export interface ServicePaths {
  configDir: string;
  logDir: string;
  launchdPlist: string;
  systemdUnit: string;
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
  return {
    configDir,
    logDir: join(configDir, 'logs'),
    launchdPlist: join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    systemdUnit: join(home, '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function currentRunnerCommand(): string {
  const exec = process.execPath;
  const script = process.argv[1];
  if (script && existsSync(script)) {
    return `${shellQuote(exec)} ${shellQuote(script)} run --service`;
  }
  return 'npx --yes @kortix/agent-tunnel run --service';
}

export function buildServiceShellCommand(options: ServiceInstallOptions = {}): string {
  const runner = currentRunnerCommand();
  if (!options.keepAwake) return `exec ${runner}`;

  if (platform() === 'darwin') {
    return `exec /usr/bin/caffeinate -dimsu ${runner}`;
  }

  if (platform() === 'linux') {
    return `if command -v systemd-inhibit >/dev/null 2>&1; then exec systemd-inhibit --what=sleep:idle --why='Kortix Agent Tunnel' ${runner}; else exec ${runner}; fi`;
  }

  return `exec ${runner}`;
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
  <true/>
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
ExecStart=/bin/sh -lc ${shellQuote(command)}
Restart=always
RestartSec=5
WorkingDirectory=${homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${stdout}
StandardError=append:${stderr}

[Install]
WantedBy=default.target
`;
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

export function installService(options: ServiceInstallOptions = {}): ServiceStatus {
  const paths = getServicePaths();
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });

  const command = buildServiceShellCommand(options);

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

  throw new Error('Background service install is currently supported on macOS launchd and Linux systemd user services.');
}

export function uninstallService(): ServiceStatus {
  const paths = getServicePaths();

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

  throw new Error('Background service uninstall is currently supported on macOS launchd and Linux systemd user services.');
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

  return {
    platform: platform(),
    installed: false,
    active: null,
    detail: 'Background service status is currently supported on macOS launchd and Linux systemd user services.',
  };
}
