import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, platform, userInfo } from 'os';
import { dirname, join } from 'path';
import { powershellQuote, shellQuote, xmlEscape } from './service-quoting';
import type { ServicePaths } from './service-paths';
import { getServicePaths } from './service-paths';

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
  /** The unit file contents `install` writes for this runner. */
  render(paths: ServicePaths, runner: RunnerParts): string;
  install(paths: ServicePaths, runner: RunnerParts): Outcome;
  uninstall(paths: ServicePaths): Outcome;
  start(paths: ServicePaths, installed: boolean): Outcome;
  stop(paths: ServicePaths, installed: boolean): Outcome;
  /** R3: stop AND keep it stopped across login and reboot, until resume. */
  pause(paths: ServicePaths, installed: boolean): Outcome;
  /** Reverses pause: enable, load, start. */
  resume(paths: ServicePaths, installed: boolean): Outcome;
  status(paths: ServicePaths, installed: boolean): Outcome;
}

/** The interpreter plus arguments the supervisor must launch. */
export interface RunnerParts {
  command: string;
  args: string[];
  /** Extra environment for the supervised process (AGENT_TUNNEL_HOME, ELECTRON_RUN_AS_NODE). */
  env?: Record<string, string>;
}

/**
 * Resolves the interpreter at start rather than baking one absolute path in.
 * A version-managed Node (nvm, fnm, volta) moves when the user upgrades, which
 * would otherwise strand the service.
 */
export function posixShellCommand(runner: RunnerParts): string {
  const interpreter = `"$(command -v ${shellQuote(runner.command)} 2>/dev/null || command -v node)"`;
  // Exported inside the command, after the login shell's profile has run, so
  // one rendering serves launchd and systemd alike and no profile can drop it.
  const env = Object.entries(runner.env ?? {});
  const exports = env.length
    ? `export ${env.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')}; `
    : '';
  return `${exports}exec ${interpreter} ${runner.args.map(shellQuote).join(' ')}`;
}

export interface Outcome {
  /** `null` means "requested, but the supervisor did not confirm". */
  active?: boolean | null;
  installed?: boolean;
  /** False while paused (disabled in the supervisor). */
  enabled?: boolean;
  /** Status only: the unit on disk equals what install would write now. */
  upToDate?: boolean;
  detail?: string;
}

interface CommandResult {
  ok: boolean;
  detail: string;
}

/** The one place a supervisor command runs. Replaced in tests. */
export const supervisor = {
  run(command: string, args: string[]): CommandResult {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      ok: result.status === 0,
      detail: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    };
  },
};
const run = (command: string, args: string[]): CommandResult => supervisor.run(command, args);

const notInstalled = (what: string): CommandResult => ({ ok: false, detail: `${what} is not installed.` });

/** Blocking pause between supervisor retries. Replaced in tests. */
export const pause = { ms(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } };

function joinDetails(...results: CommandResult[]): string {
  return results.map((result) => result.detail).filter(Boolean).join('\n');
}

function launchdTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  return `gui/${uid}`;
}

// ── templates ────────────────────────────────────────────────────────────────

function logPaths(paths: ServicePaths): { stdout: string; stderr: string } {
  const name = paths.logName ?? 'agent-tunnel';
  return { stdout: join(paths.logDir, `${name}.out.log`), stderr: join(paths.logDir, `${name}.err.log`) };
}

const description = (paths: ServicePaths) => paths.description ?? 'Kortix Agent Tunnel';

export function renderLaunchdPlist(command: string, paths: ServicePaths = getServicePaths()): string {
  const { stdout, stderr } = logPaths(paths);
  // KeepAlive is unconditional (R3): the agent never exits on its own for a bad
  // credential any more, so any exit is a crash. Pause is `launchctl disable`.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(paths.label)}</string>
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
  <key>ThrottleInterval</key>
  <integer>10</integer>
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
Description=${description(paths)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
UMask=0077
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

export function renderWindowsPowerShellScript(runner: RunnerParts): string {
  const command = powershellQuote(runner.command);
  const args = runner.args.map(powershellQuote).join(' ');
  const env = Object.entries(runner.env ?? {})
    .map(([key, value]) => `$env:${key} = ${powershellQuote(value)}\n`)
    .join('');
  return `$ErrorActionPreference = 'Continue'
${env}while ($true) {
  # The pipe makes PowerShell wait for a GUI-subsystem binary (the desktop
  # app's Kortix.exe) and set $LASTEXITCODE; a bare call returns at once.
  & ${command}${args ? ` ${args}` : ''} | Out-Null
  # The agent never exits on its own (R2), so every exit is restarted.
  Start-Sleep -Seconds 5
}
`;
}

// ── drivers ──────────────────────────────────────────────────────────────────

const launchd: ServiceDriver = {
  unitPath: (paths) => paths.launchdPlist,
  render: (paths, runner) => renderLaunchdPlist(posixShellCommand(runner), paths),

  install(paths, runner) {
    mkdirSync(dirname(paths.launchdPlist), { recursive: true });
    writeFileSync(paths.launchdPlist, launchd.render(paths, runner), { mode: 0o600 });
    run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    run('launchctl', ['enable', `${launchdTarget()}/${paths.label}`]);
    // `bootstrap` right after `bootout` often fails with "5: Input/output error"
    // while launchd still tears the old job down. Only `print` proves the job
    // is loaded, so retry until it does.
    let boot: CommandResult = { ok: false, detail: '' };
    let kick: CommandResult = { ok: false, detail: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) pause.ms(1_000);
      boot = run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist]);
      kick = run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${paths.label}`]);
      if (run('launchctl', ['print', `${launchdTarget()}/${paths.label}`]).ok) {
        return { installed: true, active: true, detail: joinDetails(boot, kick) };
      }
    }
    return { installed: true, active: null, detail: joinDetails(boot, kick) };
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
    const kick = run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${paths.label}`]);
    return { active: boot.ok || kick.ok ? true : null, detail: joinDetails(boot, kick) };
  },

  stop(paths, installed) {
    const stop = installed
      ? run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist])
      : notInstalled('LaunchAgent');
    return { detail: stop.detail };
  },

  pause(paths) {
    // `disable` is stored by launchd across logins; bootstrap refuses a disabled job.
    const disable = run('launchctl', ['disable', `${launchdTarget()}/${paths.label}`]);
    const stop = run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    return { enabled: disable.ok ? false : undefined, detail: joinDetails(disable, stop) };
  },

  resume(paths, installed) {
    const enable = run('launchctl', ['enable', `${launchdTarget()}/${paths.label}`]);
    const boot = installed
      ? run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist])
      : notInstalled('LaunchAgent');
    const kick = run('launchctl', ['kickstart', `${launchdTarget()}/${paths.label}`]);
    return { enabled: enable.ok, active: boot.ok || kick.ok ? true : null, detail: joinDetails(enable, boot, kick) };
  },

  status(paths, installed) {
    const disabled = run('launchctl', ['print-disabled', launchdTarget()]);
    const enabled = !new RegExp(`"${paths.label.replace(/\./g, '\\.')}" => (disabled|true)`).test(disabled.detail);
    const status = run('launchctl', ['print', `${launchdTarget()}/${paths.label}`]);
    return {
      active: status.ok,
      enabled,
      detail: status.detail || (installed ? readFileSync(paths.launchdPlist, 'utf8') : undefined),
    };
  },
};

const systemd: ServiceDriver = {
  unitPath: (paths) => paths.systemdUnit,
  render: (paths, runner) => renderSystemdUnit(posixShellCommand(runner), paths),

  install(paths, runner) {
    mkdirSync(dirname(paths.systemdUnit), { recursive: true });
    writeFileSync(paths.systemdUnit, systemd.render(paths, runner), { mode: 0o600 });
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    const enable = run('systemctl', ['--user', 'enable', `${paths.label}.service`]);
    // `enable --now` leaves an already-running agent alone, so an app update
    // never rolled it (R5). `restart` starts a stopped unit too.
    const restart = run('systemctl', ['--user', 'restart', `${paths.label}.service`]);
    return {
      installed: true,
      active: restart.ok ? true : null,
      detail: joinDetails(reload, enable, restart, ensureLinger()),
    };
  },

  uninstall(paths) {
    const existed = existsSync(paths.systemdUnit);
    const disable = run('systemctl', ['--user', 'disable', '--now', `${paths.label}.service`]);
    if (existed) rmSync(paths.systemdUnit, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    return { detail: disable.detail };
  },

  start(paths, installed) {
    const start = installed
      ? run('systemctl', ['--user', 'start', `${paths.label}.service`])
      : notInstalled('systemd unit');
    return { active: start.ok ? true : null, detail: start.detail };
  },

  stop(paths, installed) {
    const stop = installed
      ? run('systemctl', ['--user', 'stop', `${paths.label}.service`])
      : notInstalled('systemd unit');
    return { detail: stop.detail };
  },

  pause(paths) {
    const disable = run('systemctl', ['--user', 'disable', '--now', `${paths.label}.service`]);
    return { enabled: disable.ok ? false : undefined, active: false, detail: disable.detail };
  },

  resume(paths) {
    const enable = run('systemctl', ['--user', 'enable', '--now', `${paths.label}.service`]);
    return { enabled: enable.ok, active: enable.ok ? true : null, detail: enable.detail };
  },

  status(paths) {
    const status = run('systemctl', ['--user', 'is-active', `${paths.label}.service`]);
    const enabled = run('systemctl', ['--user', 'is-enabled', `${paths.label}.service`]);
    return { active: status.ok, enabled: enabled.ok, detail: status.detail };
  },
};

/**
 * A user service stops at logout and does not start at boot unless the user
 * lingers: an SSH-only server would go offline when the session ends.
 */
function ensureLinger(): CommandResult {
  const user = userInfo().username;
  const linger = run('loginctl', ['show-user', user, '-p', 'Linger']);
  if (/Linger=yes/.test(linger.detail)) return { ok: true, detail: '' };
  if (run('loginctl', ['enable-linger', user]).ok) return { ok: true, detail: 'Enabled lingering: the service keeps running after logout and starts at boot.' };
  return {
    ok: false,
    detail: `Warning: the service stops when you log out and starts only at your next login. Run \`loginctl enable-linger ${user}\` (may need sudo) to keep it running.`,
  };
}

/**
 * Task Scheduler definition. schtasks' own defaults stop the task on battery,
 * refuse to start it on battery, and kill it after 72 h, and a visible console
 * window ends the loop when the user closes it. Written as UTF-16, the
 * encoding schtasks /XML expects.
 */
export function renderWindowsTaskXml(paths: ServicePaths, user: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEscape(description(paths))}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>${xmlEscape(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${paths.windowsScript}"`)}</Arguments></Exec></Actions>
</Task>
`;
}

const windowsUser = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username);
const windowsTaskXmlPath = (paths: ServicePaths) => paths.windowsScript.replace(/\.ps1$/, '.xml');

const scheduledTask: ServiceDriver = {
  unitPath: (paths) => paths.windowsScript,
  render: (_paths, runner) => renderWindowsPowerShellScript(runner),

  install(paths, runner) {
    writeFileSync(paths.windowsScript, renderWindowsPowerShellScript(runner), { mode: 0o600 });
    const xml = windowsTaskXmlPath(paths);
    writeFileSync(xml, Buffer.from(`\ufeff${renderWindowsTaskXml(paths, windowsUser())}`, 'utf16le'), { mode: 0o600 });
    const create = run('schtasks.exe', ['/Create', '/TN', paths.label, '/XML', xml, '/F']);
    // /Run does nothing while the old loop runs, so an app update never rolled
    // the agent (R5). End it first; /End on a stopped task only reports an error.
    run('schtasks.exe', ['/End', '/TN', paths.label]);
    const start = run('schtasks.exe', ['/Run', '/TN', paths.label]);
    return { installed: create.ok, active: start.ok ? true : null, detail: joinDetails(create, start) };
  },

  uninstall(paths) {
    const existed = existsSync(paths.windowsScript);
    const stop = run('schtasks.exe', ['/End', '/TN', paths.label]);
    const del = run('schtasks.exe', ['/Delete', '/TN', paths.label, '/F']);
    if (existed) rmSync(paths.windowsScript, { force: true });
    rmSync(windowsTaskXmlPath(paths), { force: true });
    return { detail: joinDetails(stop, del) };
  },

  start(paths, installed) {
    const start = installed
      ? run('schtasks.exe', ['/Run', '/TN', paths.label])
      : notInstalled('Scheduled Task');
    return { active: start.ok ? true : null, detail: start.detail };
  },

  stop(paths, installed) {
    const stop = installed
      ? run('schtasks.exe', ['/End', '/TN', paths.label])
      : notInstalled('Scheduled Task');
    return { detail: stop.detail };
  },

  pause(paths) {
    const disable = run('schtasks.exe', ['/Change', '/TN', paths.label, '/DISABLE']);
    const stop = run('schtasks.exe', ['/End', '/TN', paths.label]);
    return { enabled: disable.ok ? false : undefined, active: false, detail: joinDetails(disable, stop) };
  },

  resume(paths) {
    const enable = run('schtasks.exe', ['/Change', '/TN', paths.label, '/ENABLE']);
    const start = run('schtasks.exe', ['/Run', '/TN', paths.label]);
    return { enabled: enable.ok, active: start.ok ? true : null, detail: joinDetails(enable, start) };
  },

  status(paths, installed) {
    // schtasks /Query prints localized labels and values ("Wird ausgeführt");
    // the ScheduledTask State enum is not localized: Ready, Running, Disabled, Queued.
    const status = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-ScheduledTask -TaskName ${powershellQuote(paths.label)} -ErrorAction Stop).State`,
    ]);
    const state = status.ok ? status.detail.trim() : '';
    return {
      active: state === 'Running',
      enabled: state !== 'Disabled',
      detail: state || (installed ? readFileSync(paths.windowsScript, 'utf8') : undefined),
    };
  },
};

const DRIVERS: Partial<Record<NodeJS.Platform, ServiceDriver>> = {
  darwin: launchd,
  linux: systemd,
  win32: scheduledTask,
};

export const SUPPORTED_PLATFORMS_MESSAGE =
  'Background services are supported on macOS launchd, Linux systemd user services, and Windows Scheduled Tasks.';

export function serviceDriverFor(os: NodeJS.Platform): ServiceDriver | undefined {
  return DRIVERS[os];
}

export function serviceDriver(): ServiceDriver | undefined {
  return serviceDriverFor(platform());
}
