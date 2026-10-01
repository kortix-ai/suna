import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posixShellCommand } from './service-drivers';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_INSTALL_BACKGROUND_SERVICE,
  SERVICE_LABEL,
  agentTunnelHome,
  buildServiceShellCommand,
  getServicePaths,
  runnerPartsFor,
  serviceLabelFor,
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
    // R3: the service runs forever. launchd restarts it on ANY exit, at most every 10 s.
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>10</integer>');
    expect(plist).not.toContain('SuccessfulExit');
    expect(plist).toContain('<key>Umask</key>');
    expect(plist).toContain('agent-tunnel.out.log');
    expect(plist).toContain('agent-tunnel.err.log');
  });

  test('systemd unit restarts on any exit (R3)', () => {
    const unit = renderSystemdUnit('exec /bin/echo tunnel');
    expect(unit).toContain('Description=Kortix Agent Tunnel');
    // The agent itself never exits for a bad credential any more (it waits in
    // `rejected`), so any exit is a crash worth restarting.
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
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
    expect(script).not.toContain('break');
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
      // The copy reports the same version as the CLI that installed it (R5).
      expect(JSON.parse(readFileSync(join(home, 'bin', 'package.json'), 'utf8'))).toMatchObject({ name: '@kortix/agent-tunnel' });
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

describe('AGENT_TUNNEL_HOME isolation', () => {
  const defaultHome = join(homedir(), '.agent-tunnel');

  test('defaults to ~/.agent-tunnel and honours the override', () => {
    expect(agentTunnelHome({})).toBe(defaultHome);
    expect(agentTunnelHome({ AGENT_TUNNEL_HOME: '  ' })).toBe(defaultHome);
    expect(agentTunnelHome({ AGENT_TUNNEL_HOME: '/tmp/kortix-dev/agent-tunnel' })).toBe(
      '/tmp/kortix-dev/agent-tunnel',
    );
  });

  test('the default home keeps the historical service label', () => {
    expect(serviceLabelFor(defaultHome)).toBe(SERVICE_LABEL);
    expect(serviceLabelFor(`${defaultHome}/`)).toBe(SERVICE_LABEL);
  });

  test('any other home gets a stable 8-hex suffix derived from its path', () => {
    const label = serviceLabelFor('/tmp/kortix-dev/agent-tunnel');
    expect(label).toMatch(/^ai\.kortix\.agent-tunnel\.[0-9a-f]{8}$/);
    expect(serviceLabelFor('/tmp/kortix-dev/agent-tunnel')).toBe(label);
    expect(serviceLabelFor('/tmp/kortix-dev/other')).not.toBe(label);
  });

  test('service files of a non-default home never touch the real service', () => {
    const paths = getServicePaths('/tmp/kortix-dev/agent-tunnel');
    expect(paths.label).not.toBe(SERVICE_LABEL);
    expect(paths.configDir).toBe('/tmp/kortix-dev/agent-tunnel');
    expect(paths.logDir).toBe('/tmp/kortix-dev/agent-tunnel/logs');
    expect(paths.launchdPlist).toEndWith(`/LaunchAgents/${paths.label}.plist`);
    expect(paths.systemdUnit).toEndWith(`/${paths.label}.service`);
    expect(paths.windowsScript).toStartWith('/tmp/kortix-dev/agent-tunnel');
    expect(renderLaunchdPlist('exec true', paths)).toContain(`<string>${paths.label}</string>`);
  });
});

describe('service runner', () => {
  const devPaths = getServicePaths('/tmp/kortix-dev/agent-tunnel');

  test('a Node runner carries a non-default home into the service env', () => {
    const runner = runnerPartsFor('/opt/kortix/agent-cli.js', { execPath: '/usr/local/bin/node' }, devPaths);
    expect(runner).toEqual({
      command: '/usr/local/bin/node',
      args: ['/opt/kortix/agent-cli.js', 'run', '--service'],
      env: { AGENT_TUNNEL_HOME: '/tmp/kortix-dev/agent-tunnel' },
    });
    expect(runnerPartsFor('/opt/kortix/agent-cli.js', { execPath: 'node' }, getServicePaths()).env).toEqual({});
  });

  test('an Electron runner sets ELECTRON_RUN_AS_NODE and is never vendored', () => {
    // An npx-looking path would be vendored under Node; the app bundle never is.
    const script = '/Applications/Kortix.app/Contents/Resources/agent-tunnel/agent-cli.js';
    const runner = runnerPartsFor(
      script,
      { execPath: '/Applications/Kortix.app/Contents/MacOS/Kortix', electron: '39.8.1' },
      devPaths,
    );
    expect(runner.command).toBe('/Applications/Kortix.app/Contents/MacOS/Kortix');
    expect(runner.args).toEqual([script, 'run', '--service']);
    expect(runner.env).toEqual({
      AGENT_TUNNEL_HOME: '/tmp/kortix-dev/agent-tunnel',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  test('an Electron runner carries KORTIX_CAPTURE_BIN from the installing app into the service env', () => {
    const before = process.env.KORTIX_CAPTURE_BIN;
    process.env.KORTIX_CAPTURE_BIN = '/Applications/Kortix.app/Contents/Resources/capture/kortix-capture';
    try {
      const runner = runnerPartsFor('/a/agent-cli.js', { execPath: '/a/Kortix', electron: '39.8.1' }, devPaths);
      expect(runner.env?.KORTIX_CAPTURE_BIN).toBe('/Applications/Kortix.app/Contents/Resources/capture/kortix-capture');
      // A plain Node runner never gets it.
      expect(runnerPartsFor('/a/agent-cli.js', { execPath: 'node' }, devPaths).env).toEqual({ AGENT_TUNNEL_HOME: '/tmp/kortix-dev/agent-tunnel' });
    } finally {
      if (before === undefined) delete process.env.KORTIX_CAPTURE_BIN;
      else process.env.KORTIX_CAPTURE_BIN = before;
    }
  });

  test('a Linux AppImage runs the AppImage file with a vendored bundle', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-appimage-'));
    try {
      const mount = join(home, '.mount_KortixAbc', 'resources', 'agent-tunnel');
      mkdirSync(mount, { recursive: true });
      writeFileSync(join(mount, 'agent-cli.js'), '// bundle\n');
      const paths = getServicePaths(join(home, 'agent-home'));
      const runner = runnerPartsFor(
        join(mount, 'agent-cli.js'),
        { execPath: join(home, '.mount_KortixAbc', 'kortix'), electron: '39.8.1', appImage: '/home/u/Kortix.AppImage' },
        paths,
      );
      expect(runner.command).toBe('/home/u/Kortix.AppImage');
      expect(runner.args[0]).toBe(paths.vendoredRunner);
      expect(readFileSync(paths.vendoredRunner, 'utf8')).toBe('// bundle\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('launchd and systemd commands export the runner env before exec', () => {
    const command = posixShellCommand({
      command: '/Applications/Kortix.app/Contents/MacOS/Kortix',
      args: ['agent-cli.js', 'run', '--service'],
      env: { AGENT_TUNNEL_HOME: "/tmp/it's here", ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(command).toStartWith(`export AGENT_TUNNEL_HOME='/tmp/it'\\''s here' ELECTRON_RUN_AS_NODE='1'; exec `);
    expect(renderLaunchdPlist(command, devPaths)).toContain('ELECTRON_RUN_AS_NODE=&apos;1&apos;');
    expect(renderSystemdUnit(command, devPaths)).toContain('ELECTRON_RUN_AS_NODE=');
    // No env, no export: the default service definition is unchanged.
    expect(posixShellCommand({ command: 'node', args: ['a.js'] })).toStartWith('exec ');
  });

  test('the Windows script sets the env and waits for a GUI-subsystem binary', () => {
    const script = renderWindowsPowerShellScript({
      command: 'C:\\Kortix\\Kortix.exe',
      args: ['agent-cli.js', 'run', '--service'],
      env: { AGENT_TUNNEL_HOME: 'C:\\dev\\agent-tunnel', ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(script).toContain("$env:AGENT_TUNNEL_HOME = 'C:\\dev\\agent-tunnel'");
    expect(script).toContain("$env:ELECTRON_RUN_AS_NODE = '1'");
    expect(script).toContain("& 'C:\\Kortix\\Kortix.exe' 'agent-cli.js' 'run' '--service' | Out-Null");
  });
});
