import { describe, expect, test } from 'bun:test';
import { platform } from 'os';
import {
  SERVICE_LABEL,
  buildServiceShellCommand,
  getServicePaths,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsPowerShellScript,
} from './service';

describe('agent tunnel service definitions', () => {
  test('builds a command that runs the supervised tunnel agent', () => {
    const command = buildServiceShellCommand();
    expect(command).toContain("'run'");
    expect(command).toContain("'--service'");
    expect(command).toStartWith('exec ');
  });

  test('keep-awake command wraps the service on supported platforms', () => {
    const command = buildServiceShellCommand({ keepAwake: true });
    expect(command).toContain("'run'");
    expect(command).toContain("'--service'");
    if (platform() === 'darwin') {
      expect(command).toContain('/usr/bin/caffeinate -dimsu');
    }
    if (platform() === 'linux') {
      expect(command).toContain('systemd-inhibit');
    }
  });

  test('launchd plist restarts and runs at login', () => {
    const plist = renderLaunchdPlist('exec /bin/echo tunnel');
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('agent-tunnel.out.log');
    expect(plist).toContain('agent-tunnel.err.log');
  });

  test('systemd unit restarts forever', () => {
    const unit = renderSystemdUnit('exec /bin/echo tunnel');
    expect(unit).toContain('Description=Kortix Agent Tunnel');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('agent-tunnel.out.log');
    expect(unit).toContain('agent-tunnel.err.log');
  });

  test('windows scheduled-task script restarts forever and can keep awake', () => {
    const script = renderWindowsPowerShellScript(
      { keepAwake: true },
      { command: 'node', args: ['agent-tunnel.js', 'run', '--service'] },
    );
    expect(script).toContain('SetThreadExecutionState');
    expect(script).toContain('while ($true)');
    expect(script).toContain("& 'node' 'agent-tunnel.js' 'run' '--service'");
    expect(script).toContain('Start-Sleep -Seconds 5');
  });

  test('service paths are under the user home', () => {
    const paths = getServicePaths();
    expect(paths.configDir).toContain('.agent-tunnel');
    expect(paths.logDir).toContain('.agent-tunnel');
    expect(paths.launchdPlist).toContain(`${SERVICE_LABEL}.plist`);
    expect(paths.systemdUnit).toContain(`${SERVICE_LABEL}.service`);
    expect(paths.windowsScript).toContain('agent-tunnel-service.ps1');
  });
});
