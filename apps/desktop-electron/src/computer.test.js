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

describe('access control on the machine (A1, A4, A5, X5)', () => {
  const now = Date.parse('2030-01-01T12:00:00.000Z');

  test('reads access.json like the agent: missing = always, damaged = ask', () => {
    const home = tempDir();
    expect(computer.readAccess(home)).toEqual({ mode: 'always', grantedUntil: null, deniedUntil: null, keepAwake: false });
    fs.writeFileSync(path.join(home, 'access.json'), '{');
    expect(computer.readAccess(home).mode).toBe('ask');
  });

  test('access_set grants (max 24 h), revokes, switches mode and keep-awake, and writes privately', () => {
    const home = tempDir();
    const base = computer.readAccess(home);
    expect(computer.nextAccess(base, { grantMinutes: 60 }, now)).toMatchObject({
      grantedUntil: '2030-01-01T13:00:00.000Z',
      deniedUntil: null,
    });
    expect(computer.nextAccess(base, { grantMinutes: 10_000 }, now).grantedUntil).toBe('2030-01-02T12:00:00.000Z');
    expect(computer.nextAccess({ ...base, grantedUntil: 'x' }, { revoke: true }, now).grantedUntil).toBeNull();
    expect(computer.nextAccess(base, { mode: 'off', keepAwake: true }, now)).toMatchObject({ mode: 'off', keepAwake: true });
    expect(() => computer.nextAccess(base, { mode: 'sometimes' }, now)).toThrow(/mode/);
    computer.writeAccess(home, computer.nextAccess(base, { mode: 'ask' }, now));
    expect(computer.readAccess(home).mode).toBe('ask');
    // A mode change drops the old grant and denial: back to "Ask each time" asks again.
    const granted = { mode: 'off', grantedUntil: '2030-01-01T20:00:00.000Z', deniedUntil: '2030-01-01T12:05:00.000Z', keepAwake: false };
    expect(computer.nextAccess(granted, { mode: 'ask' }, now)).toMatchObject({ mode: 'ask', grantedUntil: null, deniedUntil: null });
    expect(fs.statSync(path.join(home, 'access.json')).mode & 0o077).toBe(0);
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

  test('the page may narrow access at once; widening needs the owner (computer_access_set)', () => {
    const ask = { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false };
    const widens = (current, input) => computer.accessWidens(current, computer.nextAccess(current, input, now), now);
    expect(widens(ask, { mode: 'always' })).toBe(true);
    expect(widens(ask, { grantMinutes: 1440 })).toBe(true);
    expect(widens({ ...ask, mode: 'off' }, { mode: 'ask' })).toBe(false);
    expect(widens({ ...ask, mode: 'always' }, { mode: 'ask' })).toBe(false);
    expect(widens(ask, { mode: 'off' })).toBe(false);
    expect(widens({ ...ask, grantedUntil: '2030-01-01T13:00:00.000Z' }, { revoke: true })).toBe(false);
    expect(widens(ask, { keepAwake: true })).toBe(false);
    // "Deny" from the page's request banner: narrows, same 10 minutes as the native prompt.
    expect(computer.nextAccess({ ...ask, grantedUntil: '2030-01-01T13:00:00.000Z' }, { deny: true }, now)).toMatchObject({
      grantedUntil: null,
      deniedUntil: '2030-01-01T12:10:00.000Z',
    });
    expect(widens(ask, { deny: true })).toBe(false);
    expect(computer.widenPrompt({ mode: 'always' }, 'Studio')).toMatchObject({ buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 });
  });

  test('a decided request needs no prompt; an answer clears every request asked before it', () => {
    const ask = { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false };
    expect(computer.decideAccess(ask, now)).toBe('ask');
    expect(computer.decideAccess({ ...ask, grantedUntil: '2030-01-01T13:00:00.000Z' }, now)).toBe('run');
    expect(computer.decideAccess({ ...ask, deniedUntil: '2030-01-01T12:05:00.000Z' }, now)).toBe('denied');
    const home = tempDir();
    const request = (id, at) => fs.writeFileSync(path.join(home, 'access-request.json'), JSON.stringify({ id, capability: 'filesystem', requestedAt: new Date(at).toISOString() }));
    request('r3', now - 1_000);
    computer.clearAccessRequestsUntil(home, now);
    expect(fs.existsSync(path.join(home, 'access-request.json'))).toBe(false);
    request('r4', now + 1_000);
    computer.clearAccessRequestsUntil(home, now);
    expect(fs.existsSync(path.join(home, 'access-request.json'))).toBe(true);
  });

  test('each answer becomes the right access.json change; deny blocks for 10 minutes', () => {
    const base = { mode: 'ask', grantedUntil: null, deniedUntil: '2029-01-01T00:00:00.000Z', keepAwake: false };
    expect(computer.answerAccess(base, 0, now)).toMatchObject({ grantedUntil: '2030-01-02T12:00:00.000Z', deniedUntil: null });
    expect(computer.answerAccess(base, 1, now)).toMatchObject({ grantedUntil: '2030-01-01T13:00:00.000Z', deniedUntil: null });
    expect(computer.answerAccess(base, 2, now)).toMatchObject({ grantedUntil: null, deniedUntil: '2030-01-01T12:10:00.000Z' });
  });

  test('access_get reports the pending request only while it is fresh', () => {
    const home = tempDir();
    const fresh = { id: 'r1', capability: 'filesystem', method: 'fs.list', requestedAt: new Date(now - 5_000).toISOString() };
    fs.writeFileSync(path.join(home, 'access-request.json'), JSON.stringify(fresh));
    expect(computer.accessView(home, 'darwin', now)).toEqual({
      mode: 'always',
      grantedUntil: null,
      deniedUntil: null,
      keepAwake: false,
      keepAwakeSupported: true,
      pendingRequest: { id: 'r1', capability: 'filesystem', requestedAt: fresh.requestedAt },
    });
    expect(computer.accessView(home, 'darwin', now + 120_000).pendingRequest).toBeNull();
    expect(computer.accessView(home, 'win32', now).keepAwakeSupported).toBe(false);
  });

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

  test('computer_status combines the service view with the live state (X5)', () => {
    const service = {
      paired: true,
      tunnelId: 't1',
      apiUrl: 'http://localhost:32908/v1/tunnel',
      version: '0.1.3',
      service: { installed: true, active: true, enabled: true, upToDate: true },
    };
    expect(computer.computerStatusFrom(service, { tunnelId: 't1', status: 'online', agentVersion: '0.1.3' })).toEqual({
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
    });
    expect(computer.computerStatusFrom(service, { tunnelId: 't1', status: 'rejected', agentVersion: '0.1.3' }).state).toBe('rejected');
    // A state file from a previous pairing says nothing about this one.
    expect(computer.computerStatusFrom(service, { tunnelId: 'old', status: 'online' }).state).toBe('offline');
    const paused = { ...service, service: { installed: true, active: false, enabled: false, upToDate: true } };
    expect(computer.computerStatusFrom(paused, null)).toMatchObject({ paused: true, needsRepair: false });
    expect(
      computer.computerStatusFrom({ paired: false, service: { installed: false, active: null } }, null),
    ).toEqual({ available: true, paired: false, paused: false, serviceInstalled: false, serviceActive: false, needsRepair: false });
  });

  test('R5: a paired, unpaused service is repaired when missing, stopped, stale, or running an older agent', () => {
    const base = {
      paired: true,
      tunnelId: 't1',
      version: '0.1.3',
      service: { installed: true, active: true, enabled: true, upToDate: true },
    };
    const state = { tunnelId: 't1', status: 'online', agentVersion: '0.1.3' };
    expect(computer.computerStatusFrom(base, state).needsRepair).toBe(false);
    expect(computer.computerStatusFrom({ ...base, service: { ...base.service, installed: false } }, state).needsRepair).toBe(true);
    // Stopped with nothing holding the tunnel (readAgentState reports a dead writer as offline).
    expect(computer.computerStatusFrom({ ...base, service: { ...base.service, active: false } }, { ...state, status: 'offline' }).needsRepair).toBe(true);
    expect(computer.computerStatusFrom({ ...base, service: { ...base.service, upToDate: false } }, state).needsRepair).toBe(true);
    expect(computer.computerStatusFrom(base, { ...state, agentVersion: '0.1.2' }).needsRepair).toBe(true);
    // Paused means paused: never restarted behind the owner's back.
    expect(
      computer.computerStatusFrom({ ...base, service: { installed: true, active: false, enabled: false, upToDate: false } }, state).needsRepair,
    ).toBe(false);
    // A foreground `agent-tunnel connect` holds the tunnel: starting the service would displace it.
    const stopped = { ...base, service: { ...base.service, active: false } };
    expect(computer.computerStatusFrom(stopped, { ...state, pid: process.pid })).toMatchObject({ paused: false, needsRepair: false });
    expect(computer.statusLabel({ paired: true, paused: false, serviceActive: false, state: 'offline' })).toBe('Computer service stopped');
  });
});

describe('tray', () => {
  const noop = () => {};
  const actions = new Proxy({}, { get: () => noop });
  const online = { paired: true, tunnelId: 't1', status: 'online', state: 'online', paused: false, serviceInstalled: true, serviceActive: true };
  const access = { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false };
  const opts = { openAtLogin: true, loginItemSupported: true, keepAwakeSupported: true, now: Date.parse('2030-01-01T12:00:00.000Z') };

  test('the "Your computer" section: status, access, keep awake, pause, disconnect (A5)', () => {
    const section = computer.computerTraySection(online, access, opts, actions);
    expect(section).toMatchObject({ id: 'computer', title: 'Your computer', keepsRunning: true });
    expect(section.items.map((item) => item.label)).toEqual([
      'Connected',
      'Access',
      'Keep awake while plugged in',
      'Pause computer access',
      'Disconnect…',
    ]);
    const modes = section.items.find((item) => item.id === 'access').submenu;
    expect(modes.map((item) => [item.label, item.checked])).toEqual([
      ['Ask each time', true],
      ['Always allowed', false],
      ['Off', false],
    ]);
  });

  test('not paired: no section', () => {
    expect(computer.computerTraySection({ paired: false }, access, opts, actions)).toBeNull();
    expect(computer.computerTraySection(null, access, opts, actions)).toBeNull();
  });

  test('an active grant shows its end and a Revoke now item', () => {
    const granted = { ...access, grantedUntil: '2030-01-01T14:32:00.000Z' };
    const items = computer.computerTraySection(online, granted, opts, actions).items;
    const grant = items.find((item) => item.id === 'grant');
    expect(grant.label).toMatch(/^Allowed until /);
    expect(items.find((item) => item.id === 'revoke').label).toBe('Revoke now');
    expect(computer.computerTraySection(online, access, opts, actions).items.find((item) => item.id === 'revoke')).toBeUndefined();
  });

  test('a paused computer offers Resume and does not keep running; Windows says keep-awake is unavailable', () => {
    const paused = { ...online, paused: true, serviceActive: false, status: 'offline', state: 'offline' };
    const section = computer.computerTraySection(paused, access, { ...opts, keepAwakeSupported: false }, actions);
    expect(section.items[0].label).toBe('Access paused');
    expect(section.keepsRunning).toBe(false);
    expect(section.items.find((item) => item.id === 'pause').label).toBe('Resume computer access');
    expect(section.items.find((item) => item.id === 'keepAwake')).toMatchObject({ label: 'Keep awake: not available on Windows yet', enabled: false });
    expect(computer.statusLabel(paused)).toBe('Computer access paused');
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
    // X5 access IPC.
    expect(tray).toContain("case 'computer_access_get':");
    expect(tray).toContain("case 'computer_access_set':");
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
    const home = tempDir();
    const config = (capabilities) =>
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabledCapabilities: capabilities }));
    const none = { accessibility: false, screenRecording: false, files: null };

    expect(computer.computerSetupMissing(home, none)).toEqual([]); // not paired
    config(['shell']);
    expect(computer.computerSetupMissing(home, none)).toEqual([]);
    config(['filesystem', 'shell', 'desktop']);
    expect(computer.computerSetupMissing(home, none)).toEqual(['files', 'accessibility', 'screenRecording']);
    expect(
      computer.computerSetupMissing(home, { accessibility: true, screenRecording: false, files: true }),
    ).toEqual(['screenRecording']);
    // A folder the person refused stays missing: setup sends them to System Settings.
    config(['filesystem']);
    expect(computer.computerSetupMissing(home, { ...none, files: false })).toEqual(['files']);
    expect(computer.computerSetupMissing(home, { accessibility: true, screenRecording: true, files: true })).toEqual([]);
    expect(computer.computerSetupMissing(home, null)).toEqual([]); // not macOS
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

describe('machineId (the computer agent formula)', () => {
  const tunnel = require('../../../packages/agent-tunnel/src/agent/device-auth');
  const run = () => '| "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n';
  const reg = () => '    MachineGuid    REG_SZ    1F2E3D4C-5B6A-7980-A1B2-C3D4E5F60718\n';
  const read = () => '0123456789abcdef0123456789abcdef\n';
  test('matches packages/agent-tunnel machineId() on macOS, Windows, Linux, and this machine', () => {
    for (const [os, stub] of [['darwin', { run }], ['win32', { run: reg }], ['linux', { read }]]) {
      const ours = computer.machineId({ os, ...stub });
      expect(ours).toMatch(/^[0-9a-f]{64}$/);
      expect(ours).toBe(tunnel.machineId({ os, ...stub }));
    }
    expect(computer.machineId()).toBe(tunnel.machineId());
  });
  test('an unreadable OS id gives null', () => {
    expect(computer.machineId({ os: 'linux', read: () => { throw new Error('ENOENT'); } })).toBeNull();
  });
});
