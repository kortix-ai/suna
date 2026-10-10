// The supervisors that run the Kortix Capture service: a launchd LaunchAgent
// (macOS), a systemd user unit (Linux), a Scheduled Task (Windows). Capture's
// own module: it shares no code with the computer agent's service.
//
// Each supervisor restarts the service on any exit and starts it at login.
// `pause` stops it and keeps it stopped across logins (launchctl disable,
// systemctl disable, schtasks /DISABLE) until `resume`.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const powershellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const xmlEscape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const DESCRIPTION = 'Kortix Capture';

/** The one place a supervisor command runs. Replaced in tests. */
const supervisor = {
  run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return { ok: result.status === 0, detail: [result.stdout, result.stderr].filter(Boolean).join('\n').trim() };
  },
};
const run = (command, args) => supervisor.run(command, args);
/** Blocking pause between launchd retries. Replaced in tests. */
const wait = { ms: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) };
const joinDetails = (...results) => results.map((r) => r.detail).filter(Boolean).join('\n');
const notInstalled = (what) => ({ ok: false, detail: `${what} is not installed.` });

const logPaths = (paths) => ({
  stdout: path.join(paths.logDir, 'capture-service.out.log'),
  stderr: path.join(paths.logDir, 'capture-service.err.log'),
});

/** The interpreter is resolved at start, so a moved Node never strands the service; env is exported after the login profile. */
function posixShellCommand(runner) {
  const interpreter = `"$(command -v ${shellQuote(runner.command)} 2>/dev/null || command -v node)"`;
  const env = Object.entries(runner.env ?? {});
  const exports = env.length ? `export ${env.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')}; ` : '';
  return `${exports}exec ${interpreter} ${runner.args.map(shellQuote).join(' ')}`;
}

function renderLaunchdPlist(command, paths) {
  const { stdout, stderr } = logPaths(paths);
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
  <string>${xmlEscape(os.homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function renderSystemdUnit(command, paths) {
  const { stdout, stderr } = logPaths(paths);
  return `[Unit]
Description=${DESCRIPTION}

[Service]
Type=simple
UMask=0077
ExecStart=/bin/sh -lc ${shellQuote(command)}
Restart=always
RestartSec=5
WorkingDirectory=${os.homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${stdout}
StandardError=append:${stderr}

[Install]
WantedBy=default.target
`;
}

function renderWindowsPowerShellScript(runner) {
  const args = runner.args.map(powershellQuote).join(' ');
  const env = Object.entries(runner.env ?? {})
    .map(([key, value]) => `$env:${key} = ${powershellQuote(value)}\n`)
    .join('');
  return `$ErrorActionPreference = 'Continue'
${env}while ($true) {
  # The pipe makes PowerShell wait for a GUI-subsystem binary (Kortix.exe).
  & ${powershellQuote(runner.command)}${args ? ` ${args}` : ''} | Out-Null
  Start-Sleep -Seconds 5
}
`;
}

/** schtasks' defaults stop the task on battery and after 72 h; this definition does not. UTF-16, as /XML expects. */
function renderWindowsTaskXml(paths, user) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${DESCRIPTION}</Description></RegistrationInfo>
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

const launchdTarget = () => `gui/${typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid}`;

const launchd = {
  unitPath: (paths) => paths.launchdPlist,
  render: (paths, runner) => renderLaunchdPlist(posixShellCommand(runner), paths),
  install(paths, runner) {
    fs.mkdirSync(path.dirname(paths.launchdPlist), { recursive: true });
    fs.writeFileSync(paths.launchdPlist, launchd.render(paths, runner), { mode: 0o600 });
    run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    run('launchctl', ['enable', `${launchdTarget()}/${paths.label}`]);
    // `bootstrap` right after `bootout` can fail while launchd tears the old job
    // down; only `print` proves the job is loaded.
    let boot = { ok: false, detail: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) wait.ms(1_000);
      boot = run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist]);
      if (run('launchctl', ['print', `${launchdTarget()}/${paths.label}`]).ok) return { installed: true, active: true, detail: boot.detail };
    }
    return { installed: true, active: null, detail: boot.detail };
  },
  uninstall(paths) {
    const stop = run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    fs.rmSync(paths.launchdPlist, { force: true });
    return { detail: stop.detail };
  },
  stop(paths, installed) {
    return { detail: (installed ? run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]) : notInstalled('LaunchAgent')).detail };
  },
  pause(paths) {
    const disable = run('launchctl', ['disable', `${launchdTarget()}/${paths.label}`]);
    const stop = run('launchctl', ['bootout', launchdTarget(), paths.launchdPlist]);
    return { enabled: disable.ok ? false : undefined, detail: joinDetails(disable, stop) };
  },
  resume(paths, installed) {
    const enable = run('launchctl', ['enable', `${launchdTarget()}/${paths.label}`]);
    const boot = installed ? run('launchctl', ['bootstrap', launchdTarget(), paths.launchdPlist]) : notInstalled('LaunchAgent');
    return { enabled: enable.ok, active: boot.ok ? true : null, detail: joinDetails(enable, boot) };
  },
  status(paths) {
    const disabled = run('launchctl', ['print-disabled', launchdTarget()]);
    const enabled = !new RegExp(`"${paths.label.replace(/\./g, '\\.')}" => (disabled|true)`).test(disabled.detail);
    return { active: run('launchctl', ['print', `${launchdTarget()}/${paths.label}`]).ok, enabled };
  },
};

const systemd = {
  unitPath: (paths) => paths.systemdUnit,
  render: (paths, runner) => renderSystemdUnit(posixShellCommand(runner), paths),
  install(paths, runner) {
    fs.mkdirSync(path.dirname(paths.systemdUnit), { recursive: true });
    fs.writeFileSync(paths.systemdUnit, systemd.render(paths, runner), { mode: 0o600 });
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    const enable = run('systemctl', ['--user', 'enable', `${paths.label}.service`]);
    const restart = run('systemctl', ['--user', 'restart', `${paths.label}.service`]);
    return { installed: true, active: restart.ok ? true : null, detail: joinDetails(reload, enable, restart) };
  },
  uninstall(paths) {
    const disable = run('systemctl', ['--user', 'disable', '--now', `${paths.label}.service`]);
    fs.rmSync(paths.systemdUnit, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    return { detail: disable.detail };
  },
  stop(paths, installed) {
    return { detail: (installed ? run('systemctl', ['--user', 'stop', `${paths.label}.service`]) : notInstalled('systemd unit')).detail };
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
    return {
      active: run('systemctl', ['--user', 'is-active', `${paths.label}.service`]).ok,
      enabled: run('systemctl', ['--user', 'is-enabled', `${paths.label}.service`]).ok,
    };
  },
};

const windowsUser = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username);
const taskXmlPath = (paths) => paths.windowsScript.replace(/\.ps1$/, '.xml');

const scheduledTask = {
  unitPath: (paths) => paths.windowsScript,
  render: (_paths, runner) => renderWindowsPowerShellScript(runner),
  install(paths, runner) {
    fs.writeFileSync(paths.windowsScript, renderWindowsPowerShellScript(runner), { mode: 0o600 });
    const xml = taskXmlPath(paths);
    fs.writeFileSync(xml, Buffer.from(`﻿${renderWindowsTaskXml(paths, windowsUser())}`, 'utf16le'), { mode: 0o600 });
    const create = run('schtasks.exe', ['/Create', '/TN', paths.label, '/XML', xml, '/F']);
    run('schtasks.exe', ['/End', '/TN', paths.label]);
    const start = run('schtasks.exe', ['/Run', '/TN', paths.label]);
    return { installed: create.ok, active: start.ok ? true : null, detail: joinDetails(create, start) };
  },
  uninstall(paths) {
    const stop = run('schtasks.exe', ['/End', '/TN', paths.label]);
    const del = run('schtasks.exe', ['/Delete', '/TN', paths.label, '/F']);
    fs.rmSync(paths.windowsScript, { force: true });
    fs.rmSync(taskXmlPath(paths), { force: true });
    return { detail: joinDetails(stop, del) };
  },
  stop(paths, installed) {
    return { detail: (installed ? run('schtasks.exe', ['/End', '/TN', paths.label]) : notInstalled('Scheduled Task')).detail };
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
  status(paths) {
    // The ScheduledTask State enum is not localized: Ready, Running, Disabled, Queued.
    const status = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-ScheduledTask -TaskName ${powershellQuote(paths.label)} -ErrorAction Stop).State`,
    ]);
    const state = status.ok ? status.detail.trim() : '';
    return { active: state === 'Running', enabled: state !== 'Disabled' };
  },
};

const DRIVERS = { darwin: launchd, linux: systemd, win32: scheduledTask };

module.exports = {
  driverFor: (platform) => DRIVERS[platform],
  renderWindowsTaskXml,
  supervisor,
  wait,
  UNSUPPORTED: 'The Capture service runs on macOS (launchd), Linux (systemd user services), and Windows (Task Scheduler).',
};
