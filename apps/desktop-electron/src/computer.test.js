const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const computer = require('./computer');

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-computer-'));
  temporary.push(dir);
  return dir;
}

describe('bundled agent location and isolation', () => {
  test('a packaged app runs the extraResources copy; dev runs the repo build', () => {
    expect(computer.agentCliPath({ isPackaged: true, resourcesPath: '/App/Contents/Resources' })).toBe(
      '/App/Contents/Resources/agent-tunnel/agent-cli.js',
    );
    expect(computer.agentCliPath({ isPackaged: false })).toBe(
      path.resolve(__dirname, '../../../packages/agent-tunnel/dist/agent-cli.js'),
    );
  });

  test('only a packaged stable build uses the real ~/.agent-tunnel identity', () => {
    expect(computer.agentHome({ isPackaged: true, channel: 'stable', userData: '/u' })).toBeNull();
    expect(computer.agentHome({ isPackaged: true, channel: 'dev', userData: '/u' })).toBe('/u/agent-tunnel');
    expect(computer.agentHome({ isPackaged: false, channel: 'stable', userData: '/u' })).toBe('/u/agent-tunnel');
  });

  test('the agent runs as Node, never opens a browser, and gets exactly the chosen home', () => {
    const base = { PATH: '/bin', AGENT_TUNNEL_HOME: '/leaked/from/terminal' };
    expect(computer.agentEnv('/u/agent-tunnel', base)).toEqual({
      PATH: '/bin',
      AGENT_TUNNEL_HOME: '/u/agent-tunnel',
      ELECTRON_RUN_AS_NODE: '1',
      KORTIX_AGENT_TUNNEL_NO_BROWSER: '1',
    });
    expect(computer.agentEnv(null, base)).not.toHaveProperty('AGENT_TUNNEL_HOME');
  });
});

describe('computer_connect input validation', () => {
  test('accepts the backend of the loaded app and appends /tunnel', () => {
    expect(computer.tunnelApiUrl('https://api.kortix.com/v1', 'https://kortix.com/projects')).toEqual({
      ok: true,
      url: 'https://api.kortix.com/v1/tunnel',
    });
    expect(computer.tunnelApiUrl('https://dev-api.kortix.com/v1/', 'https://dev.kortix.com/projects')).toEqual({
      ok: true,
      url: 'https://dev-api.kortix.com/v1/tunnel',
    });
    expect(computer.tunnelApiUrl('http://localhost:32908/v1', 'http://localhost:32900/projects')).toEqual({
      ok: true,
      url: 'http://localhost:32908/v1/tunnel',
    });
  });

  test('rejects another site, plaintext remote hosts, and smuggled credentials', () => {
    const app = 'https://kortix.com/projects';
    expect(computer.tunnelApiUrl('https://evil.example/v1', app).ok).toBe(false);
    expect(computer.tunnelApiUrl('https://kortix.com.evil.example/v1', app).ok).toBe(false);
    expect(computer.tunnelApiUrl('http://api.kortix.com/v1', app).ok).toBe(false);
    expect(computer.tunnelApiUrl('https://u:p@api.kortix.com/v1', app).ok).toBe(false);
    expect(computer.tunnelApiUrl('https://api.kortix.com/v1?x=1', app).ok).toBe(false);
    expect(computer.tunnelApiUrl('file:///etc/passwd', app).ok).toBe(false);
    expect(computer.tunnelApiUrl('not a url', app).ok).toBe(false);
    // A loopback backend is only accepted for a loopback app.
    expect(computer.tunnelApiUrl('http://localhost:8008/v1', app).ok).toBe(false);
  });

  test('requires a project UUID', () => {
    expect(computer.isProjectId('3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607')).toBe(true);
    expect(computer.isProjectId('3f2a1b4c; rm -rf /')).toBe(false);
    expect(computer.isProjectId(undefined)).toBe(false);
  });
});

describe('agent output and state', () => {
  test('parses NDJSON across chunk boundaries and skips log lines', () => {
    const events = [];
    const feed = computer.ndjsonParser((event) => events.push(event));
    feed('[agent-tunnel] service starting\n{"event":"chal');
    feed('lenge","deviceCode":"ABCD-1234"}\n{"event":"approved"}\nnot json\n{broken\n');
    expect(events).toEqual([{ event: 'challenge', deviceCode: 'ABCD-1234' }, { event: 'approved' }]);
  });

  test('reports a state.json whose writer died as offline', () => {
    const home = tempDir();
    const write = (state) => fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(state));
    write({ tunnelId: 't1', status: 'online', pid: process.pid });
    expect(computer.readAgentState(home).status).toBe('online');
    write({ tunnelId: 't1', status: 'online', pid: 2 ** 22 + 12345 });
    expect(computer.readAgentState(home).status).toBe('offline');
    fs.writeFileSync(path.join(home, 'state.json'), '{');
    expect(computer.readAgentState(home)).toBeNull();
  });

  test('computer_status combines the service view with the live state', () => {
    const service = {
      paired: true,
      tunnelId: 't1',
      service: { installed: true, active: true },
    };
    expect(computer.computerStatusFrom(service, { tunnelId: 't1', status: 'online' })).toEqual({
      available: true,
      paired: true,
      tunnelId: 't1',
      status: 'online',
      serviceInstalled: true,
      serviceActive: true,
    });
    // A state file from a previous pairing says nothing about this one.
    expect(computer.computerStatusFrom(service, { tunnelId: 'old', status: 'online' }).status).toBe('offline');
    expect(
      computer.computerStatusFrom({ paired: false, service: { installed: false, active: null } }, null),
    ).toEqual({ available: true, paired: false, serviceInstalled: false, serviceActive: false });
  });
});

describe('tray', () => {
  const noop = () => {};
  const actions = new Proxy({}, { get: () => noop });
  const online = { paired: true, tunnelId: 't1', status: 'online', serviceInstalled: true, serviceActive: true };

  test('lists the computer actions in order', () => {
    const items = computer.trayMenuTemplate(online, { openAtLogin: true, loginItemSupported: true }, actions);
    expect(items.filter((item) => item.id).map((item) => item.label)).toEqual([
      'Computer connected',
      'Open Kortix',
      'Pause computer access',
      'Permissions…',
      'Show logs',
      'Open at login',
      'Disconnect this computer…',
      'Quit Kortix (your computer stays connected)',
    ]);
    expect(items.find((item) => item.id === 'login').checked).toBe(true);
  });

  test('a paused computer offers Resume; Linux has no login item', () => {
    const paused = { ...online, serviceActive: false, status: 'offline' };
    const items = computer.trayMenuTemplate(paused, { openAtLogin: false, loginItemSupported: false }, actions);
    expect(items[0].label).toBe('Computer access paused');
    expect(items.find((item) => item.id === 'pause').label).toBe('Resume computer access');
    expect(items.find((item) => item.id === 'login')).toBeUndefined();
    expect(items.find((item) => item.id === 'quit').label).toBe('Quit Kortix');
  });

  test('stays in the tray after the last window closes only while paired', () => {
    expect(computer.keepRunningInTray(online)).toBe(true);
    expect(computer.keepRunningInTray({ available: true, paired: false })).toBe(false);
    expect(computer.keepRunningInTray(null)).toBe(false);
  });
});

describe('connectComputer', () => {
  /** A stand-in for agent-cli.js that replays NDJSON events and records its argv. */
  function fakeCli(script) {
    const dir = tempDir();
    const file = path.join(dir, 'agent-cli.js');
    fs.writeFileSync(
      file,
      `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify({ argv: process.argv.slice(2), env: { run: process.env.ELECTRON_RUN_AS_NODE, home: process.env.AGENT_TUNNEL_HOME } }));\n${script}`,
    );
    return { file, argv: () => JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')) };
  }
  const emit = (event) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`;

  test('shows the challenge, then resolves with the tunnel once the service is installed', async () => {
    const cli = fakeCli(
      [
        "console.log('[agent-tunnel] noise');",
        emit({ event: 'challenge', deviceCode: 'ABCD-1234', verificationUrl: 'http://localhost:32900/tunnel/authorize/ABCD-1234', expiresAt: 'x' }),
        emit({ event: 'approved', tunnelId: 't-1', capabilities: ['filesystem'] }),
        emit({ event: 'service', action: 'install', ok: true, detail: '' }),
      ].join('\n'),
    );
    const challenges = [];
    const result = await computer.connectComputer({
      cli: cli.file,
      home: '/tmp/kortix-home',
      apiUrl: 'http://localhost:32908/v1/tunnel',
      projectId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
      onChallenge: (url) => challenges.push(url),
    });
    expect(result).toEqual({ ok: true, tunnelId: 't-1' });
    expect(challenges).toEqual(['http://localhost:32900/tunnel/authorize/ABCD-1234']);
    expect(cli.argv()).toEqual({
      argv: [
        'connect', '--json', '--daemon',
        '--api-url', 'http://localhost:32908/v1/tunnel',
        '--project-id', '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
      ],
      env: { run: '1', home: '/tmp/kortix-home' },
    });
  });

  test('reports an error event, a failed install, and a silent crash', async () => {
    const base = { home: null, apiUrl: 'http://localhost:1/v1/tunnel', projectId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607' };
    const denied = fakeCli(emit({ event: 'error', message: 'Authorization denied.' }) + '\nprocess.exitCode = 1;');
    expect(await computer.connectComputer({ ...base, cli: denied.file })).toEqual({
      ok: false,
      error: 'Authorization denied.',
    });
    const noService = fakeCli(
      emit({ event: 'approved', tunnelId: 't-1', capabilities: [] }) +
        emit({ event: 'service', action: 'install', ok: false, detail: 'launchctl failed' }),
    );
    expect(await computer.connectComputer({ ...base, cli: noService.file })).toEqual({
      ok: false,
      error: 'launchctl failed',
    });
    const crash = fakeCli("process.stderr.write('boom'); process.exit(3);");
    expect(await computer.connectComputer({ ...base, cli: crash.file })).toEqual({ ok: false, error: 'boom' });
  });

  test('aborting (the approval window was closed) stops the agent', async () => {
    const waiting = fakeCli(`${emit({ event: 'challenge', verificationUrl: 'x' })}\nsetInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const result = await computer.connectComputer({
      cli: waiting.file,
      home: null,
      apiUrl: 'http://localhost:1/v1/tunnel',
      projectId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
      signal: controller.signal,
      onChallenge: () => controller.abort(),
    });
    expect(result).toEqual({ ok: false, error: 'cancelled' });
  });
});

describe('desktop wiring', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

  test('computer_* commands pass the same trusted-sender gate as every other command', () => {
    const main = read('main.js');
    const handler = main.slice(main.indexOf("ipcMain.handle('kortix:invoke'"), main.indexOf("ipcMain.handle('kortix:navigate'"));
    expect(handler.indexOf('isTrustedSender(event)')).toBeGreaterThan(-1);
    expect(handler.indexOf("cmd.startsWith('computer_')")).toBeGreaterThan(handler.indexOf('isTrustedSender(event)'));
    expect(handler).toContain('computerShell.invoke(cmd, args)');
  });

  test('closing the last window keeps a paired computer in the tray', () => {
    expect(read('main.js')).toContain("process.platform !== 'darwin' && !computerShell?.keepRunning()");
  });

  test('launching the app again from the tray state reopens the window', () => {
    const main = read('main.js');
    const handler = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf("app.on('open-url'"));
    expect(handler).toContain('needsMainWindow(mainWindow) && app.isReady() && !instanceStore.needsSetup()');
    expect(handler).toContain('openMainWindow()');
  });

  test('the packaged app bundles the agent and the tray icons', () => {
    const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    expect(builder).toContain('from: ../../packages/agent-tunnel/dist/agent-cli.js');
    expect(builder).toContain('to: agent-tunnel/agent-cli.js');
    expect(builder).toContain('to: agent-tunnel/package.json');
    for (const icon of ['trayTemplate.png', 'trayTemplate@2x.png', 'tray.png', 'tray.ico']) {
      expect(fs.existsSync(path.join(__dirname, '..', 'assets', 'tray', icon))).toBe(true);
    }
  });
});
