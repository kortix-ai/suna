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

  test('X6: only a packaged stable build on the canonical API uses the real ~/.agent-tunnel identity', () => {
    const userData = tempDir();
    const defaultHome = tempDir();
    const canonical = 'https://api.kortix.com';
    expect(computer.agentHome({ isPackaged: true, channel: 'stable', userData, apiOrigin: canonical, defaultHome })).toBeNull();
    // Every other backend gets its own home, so a saved token never reaches another relay.
    const selfHost = computer.agentHome({ isPackaged: true, channel: 'stable', userData, apiOrigin: 'https://api.acme.example', defaultHome });
    expect(selfHost).toBe(path.join(userData, 'agent-tunnel', computer.sha8('https://api.acme.example')));
    const dev = computer.agentHome({ isPackaged: false, channel: 'stable', userData, apiOrigin: canonical, defaultHome });
    expect(dev).toBe(path.join(userData, 'agent-tunnel', computer.sha8(canonical)));
    expect(computer.sha8('https://api.kortix.com')).toMatch(/^[0-9a-f]{8}$/);
  });

  test('X6: an existing pairing keeps its home when it belongs to the same backend', () => {
    const userData = tempDir();
    const defaultHome = tempDir();
    const legacy = path.join(userData, 'agent-tunnel');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ apiUrl: 'http://localhost:32908/v1/tunnel' }));
    expect(computer.agentHome({ isPackaged: false, channel: 'dev', userData, apiOrigin: 'http://localhost:32908', defaultHome })).toBe(legacy);
    // Another backend never reuses it.
    expect(computer.agentHome({ isPackaged: false, channel: 'dev', userData, apiOrigin: 'http://localhost:8008', defaultHome })).toBe(
      path.join(legacy, computer.sha8('http://localhost:8008')),
    );
    // A stable build whose ~/.agent-tunnel already pairs this self-host keeps using it.
    fs.writeFileSync(path.join(defaultHome, 'config.json'), JSON.stringify({ apiUrl: 'https://api.acme.example/v1/tunnel' }));
    expect(computer.agentHome({ isPackaged: true, channel: 'stable', userData, apiOrigin: 'https://api.acme.example', defaultHome })).toBeNull();
    // ...and a stable build on the canonical API never takes a ~/.agent-tunnel paired with another backend.
    expect(computer.agentHome({ isPackaged: true, channel: 'stable', userData, apiOrigin: 'https://api.kortix.com', defaultHome })).toBe(
      path.join(legacy, computer.sha8('https://api.kortix.com')),
    );
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

describe('X6: the backend comes from the instance, not from the page', () => {
  const script = (config) => `window.__KORTIX_RUNTIME_CONFIG=${JSON.stringify(config)};window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;`;

  test('reads BACKEND_URL from the instance runtime config', () => {
    expect(computer.backendFromRuntimeConfig(script({ BACKEND_URL: 'http://localhost:32908/v1' }), 'http://localhost:32900')).toEqual({
      ok: true,
      url: 'http://localhost:32908/v1',
    });
    expect(computer.backendFromRuntimeConfig(script({ BACKEND_URL: 'https://api.kortix.com/v1/' }), 'https://kortix.com')).toEqual({
      ok: true,
      url: 'https://api.kortix.com/v1',
    });
    // A same-origin deployment publishes a relative backend.
    expect(computer.backendFromRuntimeConfig(script({ BACKEND_URL: '/v1' }), 'https://kortix.acme.example')).toEqual({
      ok: true,
      url: 'https://kortix.acme.example/v1',
    });
  });

  test('refuses a missing, plaintext-remote, or credential-carrying backend', () => {
    expect(computer.backendFromRuntimeConfig('<html>', 'https://kortix.com').ok).toBe(false);
    expect(computer.backendFromRuntimeConfig(script({}), 'https://kortix.com').ok).toBe(false);
    expect(computer.backendFromRuntimeConfig(script({ BACKEND_URL: 'http://api.kortix.com/v1' }), 'https://kortix.com').ok).toBe(false);
    expect(computer.backendFromRuntimeConfig(script({ BACKEND_URL: 'https://u:p@api.kortix.com/v1' }), 'https://kortix.com').ok).toBe(false);
    expect(computer.backendFromRuntimeConfig(script({ BACKEND_URL: 'https://api.kortix.com/v1?x=1' }), 'https://kortix.com').ok).toBe(false);
  });

  test('an apiUrl from the page must name exactly the derived backend', () => {
    const derived = 'https://api.kortix.com/v1';
    expect(computer.checkPageApiUrl(undefined, derived)).toBeNull();
    expect(computer.checkPageApiUrl('https://api.kortix.com/v1/', derived)).toBeNull();
    expect(computer.checkPageApiUrl('https://evil.kortix.com/v1', derived)).toMatch(/not the backend/);
    expect(computer.checkPageApiUrl('https://api.kortix.com.evil.example/v1', derived)).toMatch(/not the backend/);
    expect(computer.checkPageApiUrl('not a url', derived)).toMatch(/not the backend/);
  });

  test('project id is optional but must be a UUID when given', () => {
    expect(computer.isProjectId('3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607')).toBe(true);
    expect(computer.isProjectId('3f2a1b4c; rm -rf /')).toBe(false);
    expect(computer.isProjectId(undefined)).toBe(false);
  });
});

describe('access control: the agent CLI applies it, this app asks (A1, A4, A5, X5)', () => {
  test('keeps no copy of the access rules and never writes an agent file', () => {
    for (const name of ['readAccess', 'writeAccess', 'nextAccess', 'decideAccess', 'accessWidens', 'accessView', 'readAgentState']) {
      expect(computer[name]).toBeUndefined();
    }
    const source = fs.readFileSync(path.join(__dirname, 'computer.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'computer-tray.js'), 'utf8');
    expect(source).not.toMatch(/writePrivateJson\([^)]*'access(-request)?\.json'/);
    expect(source).not.toMatch(/readFileSync\([^)]*'(access|access-request|state)\.json'/);
  });

  test('every access change is one CLI command', () => {
    expect(computer.accessArgs({ mode: 'always' })).toEqual(['access', 'always', '--json']);
    expect(computer.accessArgs({ grantMinutes: 60 })).toEqual(['access', '--allow-for', '60', '--json']);
    expect(computer.accessArgs({ revoke: true })).toEqual(['access', '--revoke', '--json']);
    expect(computer.accessArgs({ deny: true })).toEqual(['access', '--deny', '--json']);
    expect(computer.accessArgs({ keepAwake: true })).toEqual(['keep-awake', 'on', '--json']);
    expect(computer.accessArgs({ keepAwake: false })).toEqual(['keep-awake', 'off', '--json']);
  });

  test('each prompt answer becomes the CLI command for it; cancelling a relayed change declines it', () => {
    const call = { id: 'r1', capability: 'shell' };
    expect(computer.answerArgs(call, 0)).toEqual(['access', '--allow-for', '1440', '--json']);
    expect(computer.answerArgs(call, 1)).toEqual(['access', '--allow-for', '60', '--json']);
    expect(computer.answerArgs(call, 2)).toEqual(['access', '--deny', '--json']);
    const change = { id: 'r2', capability: 'access', change: { mode: 'always' } };
    expect(computer.answerArgs(change, 0)).toEqual(['access', 'always', '--json']);
    expect(computer.answerArgs(change, 1)).toEqual(['access', '--deny', '--json']);
  });

  test('a call request needs a prompt only while access is undecided; a relayed change always does', () => {
    const request = { id: 'r1', capability: 'filesystem', requestedAt: '2030-01-01T12:00:00.000Z' };
    const ask = { mode: 'ask', grantedUntil: null, deniedUntil: null, pendingRequest: request };
    expect(computer.requestToPrompt(ask)).toBe(request);
    expect(computer.requestToPrompt({ ...ask, grantedUntil: '2030-01-01T13:00:00.000Z' })).toBeNull();
    expect(computer.requestToPrompt({ ...ask, mode: 'off' })).toBeNull();
    expect(computer.requestToPrompt({ ...ask, pendingRequest: null })).toBeNull();
    expect(computer.requestToPrompt(null)).toBeNull();
    const change = { ...request, change: { mode: 'always' } };
    expect(computer.requestToPrompt({ ...ask, mode: 'always', pendingRequest: change })).toBe(change);
  });

  test('the prompt names the machine, what the agent wants, and the whole scope of a grant; 1 hour is the default', () => {
    const prompt = computer.accessPrompt({ capability: 'shell', method: 'shell.exec' }, 'Studio');
    expect(prompt).toMatchObject({
      title: 'Allow Kortix to use Studio?',
      message: 'Allow Kortix to use Studio?',
      buttons: ['Allow for 24 hours', 'Allow for 1 hour', 'Deny'],
      defaultId: 1,
      cancelId: 2,
    });
    expect(prompt.detail).toStartWith('An agent wants to use the shell.');
    expect(prompt.detail).toContain('any Kortix agent that can reach this computer use its files, the shell, and the screen and keyboard');
    expect(computer.accessPrompt({ capability: 'filesystem' }, 'Studio').detail).toContain('use files');
    expect(computer.accessPrompt({ capability: 'desktop' }, 'Studio').detail).toContain('the screen and keyboard');
  });

  test('a wider access asked for through Kortix names what it allows; Cancel is the default', () => {
    const always = computer.widenPrompt({ mode: 'always' }, 'Studio');
    expect(always).toMatchObject({ title: 'Allow Kortix to use Studio?', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 });
    expect(always.detail).toContain('every agent call without asking you first');
    expect(always.detail).toContain('Allow it only if that was you');
    expect(computer.widenPrompt({ grantMinutes: 60 }, 'Studio').detail).toContain('for the next 1 hour');
    expect(computer.widenPrompt({ grantMinutes: 1440 }, 'Studio').detail).toContain('for the next 24 hours');
    expect(computer.widenPrompt({ grantMinutes: 30 }, 'Studio').detail).toContain('for the next 30 minutes');
  });

  test('the real agent CLI applies what this app sends and reports it in status --json', async () => {
    const home = tempDir();
    // The app runs its bundled agent-cli.js with its own binary; bun runs the source here.
    const cli = path.join(__dirname, '..', '..', '..', 'packages', 'agent-tunnel', 'src', 'agent', 'cli.ts');
    const run = (args) => computer.runAgent(args, { cli, home, execPath: process.execPath });
    for (const args of [computer.accessArgs({ mode: 'ask' }), computer.accessArgs({ keepAwake: true }), computer.answerArgs({ id: 'r', capability: 'shell' }, 1)]) {
      const result = await run(args);
      expect(result.code).toBe(0);
    }
    const status = await computer.computerStatus({ cli, home, execPath: process.execPath });
    expect(status).toMatchObject({ available: true, paired: false, access: { mode: 'ask', keepAwake: true, pendingRequest: null } });
    expect(Date.parse(status.access.grantedUntil) - Date.now()).toBeGreaterThan(59 * 60_000);
    const refused = await run(['access', 'sometimes', '--json']);
    expect(refused.code).toBe(1);
  }, 30_000);

  test('records how the agent can start this app (dev runs electron with the app path)', () => {
    expect(
      computer.desktopAppRecord({ execPath: '/A/Kortix', defaultApp: false, argv: ['/A/Kortix'], env: {}, pid: 7 }),
    ).toEqual({ command: '/A/Kortix', args: [], pid: 7, env: {} });
    // A Linux AppImage: the mount path dies with the app, the AppImage file does not.
    expect(
      computer.desktopAppRecord({ execPath: '/tmp/.mount_Kortix1/kortix', defaultApp: false, argv: [], env: { APPIMAGE: '/home/u/Kortix.AppImage' }, pid: 9 }).command,
    ).toBe('/home/u/Kortix.AppImage');
    expect(
      computer.desktopAppRecord({
        execPath: '/repo/node_modules/electron/dist/Electron',
        defaultApp: true,
        argv: ['/repo/node_modules/electron/dist/Electron', '.'],
        env: {
          KORTIX_DESKTOP_URL: 'http://localhost:3000/projects',
          KORTIX_DESKTOP_USER_DATA: '/tmp/profile',
          SECRET: 'x',
        },
        pid: 8,
        cwd: '/repo/apps/desktop-electron',
      }),
    ).toEqual({
      command: '/repo/node_modules/electron/dist/Electron',
      args: ['/repo/apps/desktop-electron'],
      pid: 8,
      // The profile must follow, or the woken app misses the single-instance lock.
      env: { KORTIX_DESKTOP_URL: 'http://localhost:3000/projects', KORTIX_DESKTOP_USER_DATA: '/tmp/profile' },
    });
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

  test('computer_status is the CLI status report, read once (X5)', () => {
    const access = { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false, keepAwakeSupported: true, pendingRequest: null };
    const report = (state, service = { installed: true, active: true, enabled: true, upToDate: true }) => ({
      paired: true,
      tunnelId: 't1',
      apiUrl: 'http://localhost:32908/v1/tunnel',
      version: '0.1.3',
      capabilities: ['filesystem', 'desktop'],
      service,
      state,
      access,
    });
    expect(computer.computerStatusFrom(report({ tunnelId: 't1', status: 'online', agentVersion: '0.1.3' }))).toEqual({
      available: true,
      paired: true,
      tunnelId: 't1',
      apiUrl: 'http://localhost:32908/v1/tunnel',
      status: 'online',
      state: 'online',
      paused: false,
      serviceInstalled: true,
      serviceActive: true,
      needsRepair: false,
      capabilities: ['filesystem', 'desktop'],
      access,
    });
    expect(computer.computerStatusFrom(report({ tunnelId: 't1', status: 'rejected', agentVersion: '0.1.3' })).state).toBe('rejected');
    // A state file from a previous pairing says nothing about this one.
    expect(computer.computerStatusFrom(report({ tunnelId: 'old', status: 'online' })).state).toBe('offline');
    expect(computer.computerStatusFrom(report(null, { installed: true, active: false, enabled: false, upToDate: true }))).toMatchObject({ paused: true, needsRepair: false });
    expect(computer.computerStatusFrom({ paired: false, service: { installed: false, active: null } })).toEqual({
      available: true,
      paired: false,
      paused: false,
      serviceInstalled: false,
      serviceActive: false,
      needsRepair: false,
      capabilities: [],
      access: null,
    });
  });

  test('R5: a paired, unpaused service is repaired when missing, stopped, stale, or running an older agent', () => {
    const state = { tunnelId: 't1', status: 'online', agentVersion: '0.1.3' };
    const service = { installed: true, active: true, enabled: true, upToDate: true };
    const status = (patch = {}, live = state) => computer.computerStatusFrom({ paired: true, tunnelId: 't1', version: '0.1.3', service: { ...service, ...patch }, state: live });
    expect(status().needsRepair).toBe(false);
    expect(status({ installed: false }).needsRepair).toBe(true);
    // Stopped with nothing holding the tunnel (the CLI reports a dead writer as offline).
    expect(status({ active: false }, { ...state, status: 'offline' }).needsRepair).toBe(true);
    expect(status({ upToDate: false }).needsRepair).toBe(true);
    expect(status({}, { ...state, agentVersion: '0.1.2' }).needsRepair).toBe(true);
    // Paused means paused: never restarted behind the owner's back.
    expect(status({ active: false, enabled: false, upToDate: false }).needsRepair).toBe(false);
    // A foreground `agent-tunnel connect` holds the tunnel: starting the service would displace it.
    expect(status({ active: false })).toMatchObject({ paused: false, needsRepair: false });
    expect(computer.statusLabel({ paired: true, paused: false, serviceActive: false, state: 'offline' })).toBe('Computer service stopped');
  });
});

describe('tray', () => {
  const noop = () => {};
  const actions = new Proxy({}, { get: () => noop });
  const access = { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false, keepAwakeSupported: true };
  const online = { paired: true, tunnelId: 't1', status: 'online', state: 'online', paused: false, serviceInstalled: true, serviceActive: true, access };
  const opts = { openAtLogin: true, loginItemSupported: true, now: Date.parse('2030-01-01T12:00:00.000Z') };

  test('lists the computer and access controls in order (A5)', () => {
    const items = computer.trayMenuTemplate(online, opts, actions);
    expect(items.filter((item) => item.id).map((item) => item.label)).toEqual([
      'Computer connected',
      'Open Kortix',
      'Access',
      'Keep this computer awake while plugged in',
      'Pause computer access',
      'Show logs',
      'Open at login',
      'Disconnect this computer…',
      'Quit Kortix (your computer stays connected)',
    ]);
    const modes = items.find((item) => item.id === 'access').submenu;
    expect(modes.map((item) => [item.label, item.checked])).toEqual([
      ['Ask each time', true],
      ['Always allowed', false],
      ['Off', false],
    ]);
    expect(items.find((item) => item.id === 'login').checked).toBe(true);
  });

  test('an active grant shows its end and a Revoke now item', () => {
    const granted = { ...online, access: { ...access, grantedUntil: '2030-01-01T14:32:00.000Z' } };
    const items = computer.trayMenuTemplate(granted, opts, actions);
    const grant = items.find((item) => item.id === 'grant');
    expect(grant.label).toMatch(/^Allowed until /);
    expect(items.find((item) => item.id === 'revoke').label).toBe('Revoke now');
    expect(computer.trayMenuTemplate(online, opts, actions).find((item) => item.id === 'revoke')).toBeUndefined();
  });

  test('a paused computer offers Resume; Linux has no login item; Windows says keep-awake is unavailable', () => {
    const paused = { ...online, paused: true, serviceActive: false, status: 'offline', state: 'offline', access: { ...access, keepAwakeSupported: false } };
    const items = computer.trayMenuTemplate(paused, { ...opts, loginItemSupported: false }, actions);
    expect(items[0].label).toBe('Computer access paused');
    expect(items.find((item) => item.id === 'pause').label).toBe('Resume computer access');
    expect(items.find((item) => item.id === 'login')).toBeUndefined();
    expect(items.find((item) => item.id === 'keepAwake')).toMatchObject({ label: 'Keep awake: not available on Windows yet', enabled: false });
    expect(items.find((item) => item.id === 'quit').label).toBe('Quit Kortix');
  });

  test('a refused credential reads as Needs reconnect', () => {
    expect(computer.statusLabel({ ...online, status: 'rejected', state: 'rejected' })).toBe('Computer needs to reconnect');
    expect(computer.statusLabel({ ...online, status: 'standby', state: 'standby' })).toBe('Computer in use by another Kortix app or terminal');
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

  test('no project and a re-pair: no --project-id, and --reauth', async () => {
    const cli = fakeCli(emit({ event: 'error', message: 'stop' }));
    await computer.connectComputer({ cli: cli.file, home: null, apiUrl: 'http://localhost:1/v1/tunnel', reauth: true });
    expect(cli.argv().argv).toEqual(['connect', '--json', '--daemon', '--api-url', 'http://localhost:1/v1/tunnel', '--reauth']);
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

  test('v2 wiring: backend from the instance, self-unpair on disconnect, no cancel on a just-approved close, launch repair', () => {
    const tray = read('computer-tray.js');
    // X6: the main process reads the backend from the instance, never from the page.
    expect(tray).toContain('net.fetch(`${appOrigin}/api/runtime-config`');
    expect(tray).toContain('computer.checkPageApiUrl(args.apiUrl, backendUrl)');
    // X4: every disconnect (tray and web) runs the agent's self-unpairing logout.
    expect(tray).toContain("run(['logout', '--json'])");
    // Finding: closing the approval window inside the 2 s poll gap must not abort.
    expect(tray).toContain('APPROVAL_CLOSE_GRACE_MS');
    // R3: pause is the agent's durable `stop`; R5: repair on launch.
    expect(tray).toContain("serviceVerb('stop'");
    expect(tray).toContain("run(['install-service'])");
    // Access is changed through Kortix (the API relays it to the agent) or
    // from the tray; the page has no local access command.
    expect(tray).not.toContain("case 'computer_access_get':");
    expect(tray).not.toContain("case 'computer_access_set':");
    // Every tray change and prompt answer runs the CLI.
    expect(tray).toContain('run(computer.accessArgs(change))');
    expect(tray).toContain('run(computer.answerArgs(request, response))');
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

describe('computer setup (the macOS grants the approved access needs)', () => {
  test('files need the protected folders; Computer Use needs Accessibility and Screen Recording', () => {
    const none = { accessibility: false, screenRecording: false, files: null };
    expect(computer.computerSetupMissing(undefined, none)).toEqual([]); // not paired
    expect(computer.computerSetupMissing(['shell'], none)).toEqual([]);
    expect(computer.computerSetupMissing(['filesystem', 'shell', 'desktop'], none)).toEqual(['files', 'accessibility', 'screenRecording']);
    expect(computer.computerSetupMissing(['filesystem', 'desktop'], { accessibility: true, screenRecording: false, files: true })).toEqual(['screenRecording']);
    // A folder the person refused stays missing: setup sends them to System Settings.
    expect(computer.computerSetupMissing(['filesystem'], { ...none, files: false })).toEqual(['files']);
    expect(computer.computerSetupMissing(['filesystem'], { accessibility: true, screenRecording: true, files: true })).toEqual([]);
    expect(computer.computerSetupMissing(['desktop'], null)).toEqual([]); // not macOS
  });

  test('Allow all always attempts a capture, so Kortix is listed under Screen Recording', () => {
    const tray = fs.readFileSync(path.join(__dirname, 'computer-tray.js'), 'utf8');
    const request = tray.slice(tray.indexOf("before.missing.includes('screenRecording')"), tray.indexOf('const needsRestart'));
    // macOS 11+ never reports 'not-determined' for the screen, so no branch may gate the capture on it.
    expect(request).not.toContain("'not-determined'");
    expect(request.indexOf('desktopCapturer.getSources')).toBeGreaterThan(-1);
    expect(request.indexOf('desktopCapturer.getSources')).toBeLessThan(request.indexOf('Privacy_ScreenCapture'));
  });
});
