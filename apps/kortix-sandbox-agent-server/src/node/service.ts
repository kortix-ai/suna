import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { nodeStateDirectory } from './config-store'

export interface ServiceStatus {
  supported: boolean
  installed: boolean
  active: boolean | null
  manager: 'launchd' | 'systemd' | 'task-scheduler' | 'unsupported'
  definition: string | null
}

const LABEL = 'com.kortix.kortixd'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function servicePaths(env: NodeJS.ProcessEnv = process.env) {
  const state = nodeStateDirectory(env)
  const home = homedir()
  return {
    state,
    stdout: join(state, 'kortixd.stdout.log'),
    stderr: join(state, 'kortixd.stderr.log'),
    launchd: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    systemd: join(home, '.config', 'systemd', 'user', 'kortixd.service'),
    windowsScript: join(state, 'kortixd-service.ps1'),
  }
}

export function renderLaunchAgent(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  const paths = servicePaths(env)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>supervise</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(paths.stdout)}</string>
<key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>
</dict></plist>
`
}

export function renderSystemdUnit(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  const paths = servicePaths(env)
  return `[Unit]
Description=Kortix compute-node daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${shellQuote(executable)} supervise
Restart=on-failure
RestartSec=5
StandardOutput=append:${paths.stdout}
StandardError=append:${paths.stderr}

[Install]
WantedBy=default.target
`
}

export function renderWindowsRunner(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  const paths = servicePaths(env)
  return `& ${powershellQuote(executable)} 'supervise' >> ${powershellQuote(paths.stdout)} 2>> ${powershellQuote(paths.stderr)}\r\n`
}

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return {
    ok: result.exitCode === 0,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  }
}

function definitionPath(): string | null {
  const paths = servicePaths()
  if (process.platform === 'darwin') return paths.launchd
  if (process.platform === 'linux') return paths.systemd
  if (process.platform === 'win32') return paths.windowsScript
  return null
}

export function getServiceStatus(): ServiceStatus {
  const path = definitionPath()
  if (!path) return { supported: false, installed: false, active: null, manager: 'unsupported', definition: null }
  const installed = existsSync(path)
  if (process.platform === 'darwin') {
    const status = installed ? run('launchctl', ['print', `gui/${process.getuid?.()}/${LABEL}`]) : { ok: false }
    return { supported: true, installed, active: installed ? status.ok : false, manager: 'launchd', definition: path }
  }
  if (process.platform === 'linux') {
    const status = installed ? run('systemctl', ['--user', 'is-active', '--quiet', 'kortixd.service']) : { ok: false }
    return { supported: true, installed, active: installed ? status.ok : false, manager: 'systemd', definition: path }
  }
  const status = installed ? run('schtasks.exe', ['/Query', '/TN', LABEL, '/FO', 'LIST']) : { ok: false, output: '' }
  return { supported: true, installed, active: installed ? status.ok && /Running/i.test(status.output) : false, manager: 'task-scheduler', definition: path }
}

export function installService(executable = process.execPath): ServiceStatus {
  const paths = servicePaths()
  mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  if (process.platform === 'darwin') {
    mkdirSync(dirname(paths.launchd), { recursive: true })
    writeFileSync(paths.launchd, renderLaunchAgent(executable), { mode: 0o600 })
    run('launchctl', ['bootout', `gui/${process.getuid?.()}`, paths.launchd])
    const result = run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, paths.launchd])
    if (!result.ok) throw new Error(result.output || 'launchctl bootstrap failed')
  } else if (process.platform === 'linux') {
    mkdirSync(dirname(paths.systemd), { recursive: true })
    writeFileSync(paths.systemd, renderSystemdUnit(executable), { mode: 0o600 })
    const reload = run('systemctl', ['--user', 'daemon-reload'])
    const enable = run('systemctl', ['--user', 'enable', '--now', 'kortixd.service'])
    if (!reload.ok || !enable.ok) throw new Error(enable.output || reload.output || 'systemd installation failed')
  } else if (process.platform === 'win32') {
    writeFileSync(paths.windowsScript, renderWindowsRunner(executable), { mode: 0o600 })
    const task = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${powershellQuote(paths.windowsScript)}`
    const result = run('schtasks.exe', ['/Create', '/TN', LABEL, '/TR', task, '/SC', 'ONLOGON', '/F'])
    if (!result.ok) throw new Error(result.output || 'Task Scheduler installation failed')
    run('schtasks.exe', ['/Run', '/TN', LABEL])
  } else {
    throw new Error(`Background services are not supported on ${process.platform}`)
  }
  return getServiceStatus()
}

export function controlService(action: 'start' | 'stop' | 'restart'): ServiceStatus {
  const current = getServiceStatus()
  if (!current.installed) {
    if (action === 'start') return installService()
    throw new Error('kortixd service is not installed')
  }
  let result: { ok: boolean; output: string }
  if (process.platform === 'darwin') {
    const target = `gui/${process.getuid?.()}/${LABEL}`
    if (action === 'stop') result = run('launchctl', ['kill', 'SIGTERM', target])
    else result = run('launchctl', ['kickstart', ...(action === 'restart' ? ['-k'] : []), target])
  } else if (process.platform === 'linux') {
    result = run('systemctl', ['--user', action, 'kortixd.service'])
  } else {
    if (action === 'stop') result = run('schtasks.exe', ['/End', '/TN', LABEL])
    else {
      if (action === 'restart') run('schtasks.exe', ['/End', '/TN', LABEL])
      result = run('schtasks.exe', ['/Run', '/TN', LABEL])
    }
  }
  if (!result.ok) throw new Error(result.output || `service ${action} failed`)
  return getServiceStatus()
}

export function uninstallService(): boolean {
  const paths = servicePaths()
  const current = getServiceStatus()
  if (!current.installed) return false
  if (process.platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid?.()}`, paths.launchd])
  else if (process.platform === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', 'kortixd.service'])
    run('systemctl', ['--user', 'daemon-reload'])
  } else run('schtasks.exe', ['/Delete', '/TN', LABEL, '/F'])
  rmSync(current.definition!, { force: true })
  return true
}

export function readServiceLogs(lines = 100): string {
  const paths = servicePaths()
  const content = [paths.stdout, paths.stderr]
    .filter(existsSync)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  return content.split(/\r?\n/).slice(-Math.min(Math.max(lines, 1), 10_000)).join('\n')
}
