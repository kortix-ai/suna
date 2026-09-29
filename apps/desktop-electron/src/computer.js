// This computer as a Kortix account: the bundled @kortix/agent-tunnel CLI,
// run with this app's own binary as Node (ELECTRON_RUN_AS_NODE=1). No Electron
// imports here, so every rule below is unit-tested with plain bun.
//
// The CLI owns pairing, credentials, the OS service, and state.json. This
// module only spawns it, parses its NDJSON events, and reads its files.

const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_AGENT_DIR = path.join(__dirname, '..', '..', '..', 'packages', 'agent-tunnel');

/** Packaged: electron-builder extraResources. Unpackaged: the repo build output. */
function agentCliPath({ isPackaged, resourcesPath }) {
  return isPackaged
    ? path.join(resourcesPath, 'agent-tunnel', 'agent-cli.js')
    : path.join(REPO_AGENT_DIR, 'dist', 'agent-cli.js');
}

/** Dev only: build the bundle once when it is missing. Returns the path. */
function ensureDevAgentCli() {
  const cli = agentCliPath({ isPackaged: false });
  if (!fs.existsSync(cli)) {
    console.log('[kortix] building packages/agent-tunnel (dist/agent-cli.js is missing)…');
    execFileSync('bun', ['run', 'build'], { cwd: REPO_AGENT_DIR, stdio: 'inherit' });
  }
  if (!fs.existsSync(cli)) throw new Error(`agent-tunnel build did not produce ${cli}`);
  return cli;
}

/**
 * Config directory for the agent. A packaged stable build uses the default
 * (~/.agent-tunnel, service `ai.kortix.agent-tunnel`), the same machine
 * identity the npm CLI uses. Every other build gets its own directory under
 * userData, and so its own suffixed service, and never touches the real one.
 */
function agentHome({ isPackaged, channel, userData }) {
  return isPackaged && channel === 'stable' ? null : path.join(userData, 'agent-tunnel');
}

function effectiveHome(home) {
  return home || path.join(os.homedir(), '.agent-tunnel');
}

function agentEnv(home, base = process.env) {
  const env = { ...base, ELECTRON_RUN_AS_NODE: '1', KORTIX_AGENT_TUNNEL_NO_BROWSER: '1' };
  if (home) env.AGENT_TUNNEL_HOME = home;
  else delete env.AGENT_TUNNEL_HOME;
  return env;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

// ponytail: last two DNS labels approximate the registrable domain; a public
// suffix list is the upgrade if a self-host on a two-label public suffix needs it.
function siteOf(host) {
  return host.split('.').slice(-2).join('.');
}

/**
 * The relay URL for `connect --api-url`, from the backend URL the web app
 * passes. The backend must be https (http only on loopback) and belong to the
 * same site as the loaded app, so a page cannot pair this machine to a relay
 * of its choosing.
 */
function tunnelApiUrl(apiUrl, appUrl) {
  let api;
  let app;
  try {
    api = new URL(String(apiUrl || ''));
    app = new URL(appUrl);
  } catch {
    return { ok: false, error: 'apiUrl must be an absolute URL' };
  }
  if (api.username || api.password || api.search || api.hash) {
    return { ok: false, error: 'apiUrl must not carry credentials, a query, or a fragment' };
  }
  const loopback = isLoopbackHost(api.hostname);
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'apiUrl must use https (http only on localhost)' };
  }
  const sameSite = loopback
    ? isLoopbackHost(app.hostname)
    : siteOf(api.hostname) === siteOf(app.hostname);
  if (!sameSite) return { ok: false, error: `apiUrl ${api.origin} is not the backend of ${app.origin}` };
  return { ok: true, url: `${api.origin}${api.pathname.replace(/\/+$/, '')}/tunnel` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProjectId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** Feeds stdout chunks, calls `onEvent` per JSON line. Other lines are ignored. */
function ndjsonParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* not an event */
      }
    }
  };
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** state.json, with a dead writer reported as offline. */
function readAgentState(home) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(effectiveHome(home), 'state.json'), 'utf8'));
    if (!state || typeof state.status !== 'string') return null;
    return state.status !== 'offline' && !isAlive(state.pid) ? { ...state, status: 'offline' } : state;
  } catch {
    return null;
  }
}

/** The `computer_status` answer, from `service-status --json` plus state.json. */
function computerStatusFrom(serviceStatus, state) {
  const paired = serviceStatus?.paired === true;
  const service = serviceStatus?.service || {};
  const status = paired ? (state && state.tunnelId === serviceStatus.tunnelId ? state.status : 'offline') : undefined;
  return {
    available: true,
    paired,
    ...(paired ? { tunnelId: serviceStatus.tunnelId, status } : {}),
    serviceInstalled: service.installed === true,
    serviceActive: service.active === true,
  };
}

/** Runs one CLI command to completion. Never rejects. */
function runAgent(args, { cli, home, execPath = process.execPath, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    execFile(
      execPath,
      [cli, ...args],
      { env: agentEnv(home), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

async function computerStatus(options) {
  const result = await runAgent(['service-status', '--json'], options);
  try {
    return computerStatusFrom(JSON.parse(result.stdout), readAgentState(options.home));
  } catch {
    return unavailable((result.stderr || result.stdout || 'agent status failed').trim().slice(-500));
  }
}

/** One shape for every computer_status answer, so callers never branch on it. */
function unavailable(error) {
  return { available: false, paired: false, serviceInstalled: false, serviceActive: false, error };
}

/**
 * Pairs this machine and installs the service: `connect --json --daemon`.
 * Resolves `{ ok: true, tunnelId, existing? }` once the service is installed,
 * `{ ok: false, error }` otherwise. `onChallenge(url)` shows the approval page.
 * Aborting `signal` stops the agent and resolves `cancelled`.
 */
function connectComputer({ cli, home, apiUrl, projectId, onChallenge, onApproved, signal, execPath = process.execPath }) {
  return new Promise((resolve) => {
    const child = spawn(
      execPath,
      [cli, 'connect', '--json', '--daemon', '--api-url', apiUrl, '--project-id', projectId],
      { env: agentEnv(home), stdio: ['ignore', 'pipe', 'pipe'], signal },
    );
    let settled = false;
    let approved = null;
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on(
      'data',
      ndjsonParser((event) => {
        if (event.event === 'challenge') onChallenge?.(event.verificationUrl);
        else if (event.event === 'approved') {
          approved = event;
          onApproved?.(event);
        } else if (event.event === 'error') finish({ ok: false, error: event.message });
        else if (event.event === 'service') {
          finish(
            event.ok && approved
              ? { ok: true, tunnelId: approved.tunnelId, ...(approved.existing ? { existing: true } : {}) }
              : { ok: false, error: event.detail || 'The background service could not be installed.' },
          );
        }
      }),
    );
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on('error', (error) => {
      finish({ ok: false, error: error.name === 'AbortError' ? 'cancelled' : error.message });
    });
    // 'close', not 'exit': stdout is fully read by then, so a final event wins.
    child.on('close', (code) => {
      finish(
        signal?.aborted
          ? { ok: false, error: 'cancelled' }
          : { ok: false, error: stderr.trim() || `agent exited with code ${code}` },
      );
    });
  });
}

/** Tray status line. */
function statusLabel(status) {
  if (!status?.paired) return 'Computer not connected';
  if (!status.serviceActive) return 'Computer access paused';
  if (status.status === 'online') return 'Computer connected';
  if (status.status === 'connecting') return 'Computer connecting…';
  return 'Computer offline';
}

/**
 * Tray menu. `actions` are the click handlers; this stays a plain template so
 * the item list is tested without Electron.
 */
function trayMenuTemplate(status, { openAtLogin, loginItemSupported }, actions) {
  const paused = status?.paired && !status.serviceActive;
  return [
    { id: 'status', label: statusLabel(status), enabled: false },
    { type: 'separator' },
    { id: 'open', label: 'Open Kortix', click: actions.open },
    {
      id: 'pause',
      label: paused ? 'Resume computer access' : 'Pause computer access',
      enabled: Boolean(status?.paired),
      click: paused ? actions.resume : actions.pause,
    },
    { id: 'permissions', label: 'Permissions…', click: actions.permissions },
    { id: 'logs', label: 'Show logs', click: actions.logs },
    { type: 'separator' },
    ...(loginItemSupported
      ? [{ id: 'login', label: 'Open at login', type: 'checkbox', checked: openAtLogin, click: actions.toggleLogin }]
      : []),
    { id: 'disconnect', label: 'Disconnect this computer…', enabled: Boolean(status?.paired), click: actions.disconnect },
    { type: 'separator' },
    {
      id: 'quit',
      label: status?.paired && status.serviceActive ? 'Quit Kortix (your computer stays connected)' : 'Quit Kortix',
      click: actions.quit,
    },
  ];
}

/** Keep the app alive in the tray, instead of quitting, when a computer is paired. */
function keepRunningInTray(status) {
  return status?.paired === true;
}

module.exports = {
  agentCliPath,
  agentEnv,
  agentHome,
  computerStatus,
  computerStatusFrom,
  connectComputer,
  effectiveHome,
  ensureDevAgentCli,
  isProjectId,
  keepRunningInTray,
  ndjsonParser,
  readAgentState,
  runAgent,
  statusLabel,
  trayMenuTemplate,
  tunnelApiUrl,
  unavailable,
};
