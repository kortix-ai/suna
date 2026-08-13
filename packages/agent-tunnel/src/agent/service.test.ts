import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_INSTALL_BACKGROUND_SERVICE,
  SERVICE_LABEL,
  buildServiceShellCommand,
  getServicePaths,
  isEphemeralRunnerPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsPowerShellScript,
  vendorRunner,
} from './service';

describe('agent tunnel service definitions', () => {
  test('defaults the interactive connection flow to the background service', () => {
    expect(DEFAULT_INSTALL_BACKGROUND_SERVICE).toBe(true);
  });

  test('builds a command that runs the supervised tunnel agent', () => {
    const command = buildServiceShellCommand();
    expect(command).toContain("'run'");
    expect(command).toContain("'--service'");
    expect(command).toStartWith('exec ');
  });

  test('launchd plist restarts and runs at login', () => {
    const plist = renderLaunchdPlist('exec /bin/echo tunnel');
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>Umask</key>');
    expect(plist).toContain('agent-tunnel.out.log');
    expect(plist).toContain('agent-tunnel.err.log');
  });

  test('systemd unit restarts forever', () => {
    const unit = renderSystemdUnit('exec /bin/echo tunnel');
    expect(unit).toContain('Description=Kortix Agent Tunnel');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('UMask=0077');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('agent-tunnel.out.log');
    expect(unit).toContain('agent-tunnel.err.log');
  });

  test('windows scheduled-task script restarts forever', () => {
    const script = renderWindowsPowerShellScript({
      command: 'node',
      args: ['agent-tunnel.js', 'run', '--service'],
    });
    expect(script).not.toContain('SetThreadExecutionState');
    expect(script).toContain('while ($true)');
    expect(script).toContain("& 'node' 'agent-tunnel.js' 'run' '--service'");
    expect(script).toContain('Start-Sleep -Seconds 5');
  });

  test('treats package-manager caches as ephemeral runner locations', () => {
    expect(
      isEphemeralRunnerPath(
        '/Users/x/.npm/_npx/d2c324008dde6a9b/node_modules/@kortix/agent-tunnel/dist/agent-cli.js',
      ),
    ).toBe(true);
    expect(isEphemeralRunnerPath('/Users/x/.npm/_cacache/content-v2/sha512/ab/cd')).toBe(true);
    expect(isEphemeralRunnerPath('/usr/local/lib/node_modules/@kortix/agent-tunnel/dist/agent-cli.js')).toBe(false);
    expect(isEphemeralRunnerPath('/opt/homebrew/bin/agent-tunnel')).toBe(false);
  });

  test('vendors an npx-cached runner into the config directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-vendor-'));
    try {
      const paths = {
        ...getServicePaths(),
        binDir: join(home, 'bin'),
        vendoredRunner: join(home, 'bin', 'agent-cli.js'),
      };

      // A stable install location is used as-is.
      const stable = join(home, 'agent-cli.js');
      writeFileSync(stable, '// bundle\n');
      expect(vendorRunner(stable, paths)).toBe(stable);

      // An npx cache path is copied out to the stable location instead.
      const cacheDir = join(home, '_npx', 'abc');
      mkdirSync(cacheDir, { recursive: true });
      const cached = join(cacheDir, 'agent-cli.js');
      writeFileSync(cached, '// cached bundle\n');
      const copied = vendorRunner(cached, paths);
      expect(copied).toBe(paths.vendoredRunner);
      expect(readFileSync(copied, 'utf8')).toBe('// cached bundle\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('resolves the interpreter at start instead of pinning one absolute path', () => {
    const command = buildServiceShellCommand();
    expect(command).toContain('command -v node');
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
