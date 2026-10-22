// This computer as a Kortix account: the bundled @kortix/agent-tunnel CLI,
// run with this app's own binary as Node (ELECTRON_RUN_AS_NODE=1). No Electron
// imports here, so every rule below is unit-tested with plain bun.
//
// The CLI is the one control surface of this computer: pairing, credentials,
// the OS service, access, keep awake, and the status this app shows. This
// module only spawns it, parses its JSON, and builds its arguments. It reads
// no agent file except config.json's relay, to pick the agent home (X6).

const { execFile, execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
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

/** The only backend whose machines use the default ~/.agent-tunnel identity. */
const CANONICAL_API_ORIGIN = 'https://api.kortix.com';

const sha8 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

/** Origin of the relay a config dir is paired with, or null. */
function pairedOrigin(dir) {
  try {
    return new URL(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).apiUrl).origin;
  } catch {
    return null;
  }
}

/**
 * X6: config directory for the agent, per backend, so a saved token is never
 * sent to another relay. `null` = the default ~/.agent-tunnel (the identity
 * the npm CLI uses): only a packaged stable build, and only when that
 * directory is paired with this backend, or is unpaired and this is the
 * canonical API. A default home paired with another backend is never used.
 * Everything else lives under userData: the pre-v2 `agent-tunnel` dir while it
 * still pairs this backend, else `agent-tunnel/<sha8(apiOrigin)>`.
 */
function agentHome({ isPackaged, channel, userData, apiOrigin, defaultHome = path.join(os.homedir(), '.agent-tunnel') }) {
  const defaultPairedWith = pairedOrigin(defaultHome);
  if (
    isPackaged &&
    channel === 'stable' &&
    (defaultPairedWith === apiOrigin || (defaultPairedWith === null && apiOrigin === CANONICAL_API_ORIGIN))
  ) {
    return null;
  }
  // ponytail: the pre-v2 home keeps an existing dev pairing working; delete
  // this branch once no desktop build before v2 remains paired.
  const legacy = path.join(userData, 'agent-tunnel');
  return pairedOrigin(legacy) === apiOrigin ? legacy : path.join(legacy, sha8(apiOrigin));
}

function effectiveHome(home) {
  return home || path.join(os.homedir(), '.agent-tunnel');
}

/** This app's own files (the backend cache, desktop-app.json): atomic and private. */
function writePrivateJson(home, name, value) {
  const dir = effectiveHome(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The macOS grants this machine's approved access still needs, in the order
 * setup asks for them. Files (`filesystem`) need the protected folders
 * (Desktop, Documents, Downloads); Computer Use (`desktop`) needs
 * Accessibility and Screen Recording. All of them belong to Kortix: the agent
 * runs as this app's binary and the bundled driver runs embedded under it.
 * `capabilities` come from `status --json`; `grants` is null off macOS.
 *
 * @param {string[] | undefined} capabilities
 * @param {{ accessibility: boolean, screenRecording: boolean, files: boolean | null } | null} grants
 * @returns {('files' | 'accessibility' | 'screenRecording')[]}
 */
function computerSetupMissing(capabilities, grants) {
  if (!grants || !Array.isArray(capabilities)) return [];
  const missing = [];
  if (capabilities.includes('filesystem') && grants.files !== true) missing.push('files');
  if (capabilities.includes('desktop')) {
    if (!grants.accessibility) missing.push('accessibility');
    if (!grants.screenRecording) missing.push('screenRecording');
  }
  return missing;
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

/**
 * X6: the backend URL from the instance's own `/api/runtime-config` script,
 * fetched by the main process. The page never chooses the relay.
 */
function backendFromRuntimeConfig(script, appOrigin) {
  const match = /__KORTIX_RUNTIME_CONFIG=(\{.*?\});/s.exec(String(script || ''));
  let raw;
  try {
    raw = match && JSON.parse(match[1]).BACKEND_URL;
  } catch {
    raw = null;
  }
  if (typeof raw !== 'string' || !raw) return { ok: false, error: 'The Kortix instance does not publish its backend URL.' };
  let api;
  try {
    api = new URL(raw, appOrigin);
  } catch {
    return { ok: false, error: 'The Kortix instance publishes an invalid backend URL.' };
  }
  if (api.username || api.password || api.search || api.hash) {
    return { ok: false, error: 'The backend URL must not carry credentials, a query, or a fragment.' };
  }
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && isLoopbackHost(api.hostname))) {
    return { ok: false, error: 'The backend URL must use https (http only on localhost).' };
  }
  return { ok: true, url: `${api.origin}${api.pathname.replace(/\/+$/, '')}` };
}

/** A page may still pass `apiUrl` (older web builds): it must name exactly the derived backend. */
function checkPageApiUrl(given, backendUrl) {
  if (given === undefined || given === null || given === '') return null;
  try {
    const page = new URL(String(given));
    const derived = new URL(backendUrl);
    if (page.origin === derived.origin && page.pathname.replace(/\/+$/, '') === derived.pathname.replace(/\/+$/, '')) return null;
  } catch {
    /* fall through */
  }
  return `apiUrl is not the backend of this Kortix instance (${backendUrl})`;
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

/* ─── Access (contract v2 §A) ───────────────────────────────────────────
   The CLI applies every change (`access`, `keep-awake`) with the agent's own
   rules. This app builds the arguments and shows the native prompts. */

/** CLI arguments for one access change (agent-tunnel `AccessChange`). */
function accessArgs(change = {}) {
  if (change.keepAwake !== undefined && Object.keys(change).length === 1) {
    return ['keep-awake', change.keepAwake ? 'on' : 'off', '--json'];
  }
  const args = ['access'];
  if (change.mode) args.push(change.mode);
  if (change.grantMinutes !== undefined) args.push('--allow-for', String(change.grantMinutes));
  if (change.revoke) args.push('--revoke');
  if (change.deny) args.push('--deny');
  return [...args, '--json'];
}

/**
 * The owner's answer to the pending request, as CLI arguments. A call
 * request: 0 = 24 h, 1 = 1 h, 2 = deny. A change asked for through Kortix:
 * 0 = make it, anything else = decline it.
 */
function answerArgs(request, response) {
  if (request.change) return response === 0 ? accessArgs(request.change) : accessArgs({ deny: true });
  if (response === 0) return accessArgs({ grantMinutes: 24 * 60 });
  if (response === 1) return accessArgs({ grantMinutes: 60 });
  return accessArgs({ deny: true });
}

/**
 * The request the owner must answer now, or null. A call request needs an
 * answer only while access is undecided: no grant, no denial, `ask`.
 */
function requestToPrompt(access) {
  const request = access?.pendingRequest;
  if (!request) return null;
  if (request.change) return request;
  return access.mode === 'ask' && !access.grantedUntil && !access.deniedUntil ? request : null;
}

const CAPABILITY_WORDS = { filesystem: 'files', shell: 'the shell', desktop: 'the screen and keyboard' };

/**
 * A4: the native prompt. Button index 0 = 24 h, 1 = 1 h (default), 2 = deny.
 * One grant covers every capability this computer approved and every agent
 * that can reach it, so the prompt says so, and the shorter grant is the
 * default. ponytail: per-capability grants replace this if owners need them.
 */
function accessPrompt(request, machineName) {
  const title = `Allow Kortix to use ${machineName}?`;
  return {
    type: 'question',
    title,
    message: title,
    detail:
      `An agent wants to use ${CAPABILITY_WORDS[request.capability] || 'this computer'}. ` +
      'Allowing lets any Kortix agent that can reach this computer use its files, the shell, and the screen and keyboard until the time runs out. ' +
      'You can revoke access at any time from the menu bar.',
    buttons: ['Allow for 24 hours', 'Allow for 1 hour', 'Deny'],
    defaultId: 1,
    cancelId: 2,
  };
}

/** The owner's confirmation of a wider access asked for through Kortix (a relayed change). */
function widenPrompt(change, machineName) {
  const minutes = change.grantMinutes;
  const what =
    change.mode === 'always'
      ? 'every agent call without asking you first'
      : `every agent call for the next ${minutes >= 60 ? `${Math.round(minutes / 60)} hour${minutes >= 120 ? 's' : ''}` : `${minutes} minutes`} without asking you first`;
  return {
    type: 'warning',
    title: `Allow Kortix to use ${machineName}?`,
    message: `Allow Kortix to use ${machineName}?`,
    detail: `Someone signed in to Kortix as you asked to allow ${what}: files, the shell, and the screen and keyboard. Allow it only if that was you. You can revoke access at any time from the menu bar.`,
    buttons: ['Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  };
}

/** `<home>/desktop-app.json`: how the agent starts this app to show a prompt (A3). */
function desktopAppRecord({ execPath, defaultApp, argv, env, pid, cwd = process.cwd() }) {
  // `electron .` (dev) needs the app path; a packaged app is its own binary.
  const args = defaultApp && argv[1] ? [path.resolve(cwd, argv[1])] : [];
  // Every KORTIX_DESKTOP_* override: without KORTIX_DESKTOP_USER_DATA a woken
  // app opens another profile, misses the single-instance lock, and watches
  // the wrong agent home.
  const keep = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => key.startsWith('KORTIX_DESKTOP_') && typeof value === 'string'),
  );
  // A Linux AppImage runs from a /tmp/.mount_* path that is gone once it quits;
  // the AppImage file itself is what starts it again.
  return { command: env.APPIMAGE || execPath, args, pid, env: keep };
}

/**
 * The `computer_status` answer (X5), from `status --json`. `needsRepair`
 * (R5): paired, not paused, and the service is missing, stopped, stale, or
 * runs another agent version than this app bundles. `access` and
 * `capabilities` are the CLI's own view; the tray and the prompts use them.
 */
function computerStatusFrom(report) {
  const paired = report?.paired === true;
  const service = report?.service || {};
  const state = report?.state;
  // Paused = disabled in the supervisor. Installed, enabled and not running is
  // "stopped", which repair fixes.
  const paused = service.installed === true && service.enabled === false;
  const live = paired && state && state.tunnelId === report.tunnelId ? state : null;
  const current = paired ? (live ? live.status : 'offline') : undefined;
  // A live agent while the service is not running is a foreground
  // `agent-tunnel connect`: starting the service would displace it (4004).
  const heldInForeground = service.active !== true && Boolean(live) && ['online', 'connecting', 'standby'].includes(live.status);
  const needsRepair =
    paired &&
    !paused &&
    !heldInForeground &&
    (service.installed !== true ||
      service.active !== true ||
      service.upToDate === false ||
      Boolean(live?.agentVersion && report.version && live.agentVersion !== report.version));
  return {
    available: true,
    paired,
    ...(paired ? { tunnelId: report.tunnelId, apiUrl: report.apiUrl, status: current, state: current } : {}),
    paused,
    serviceInstalled: service.installed === true,
    serviceActive: service.active === true,
    needsRepair,
    capabilities: Array.isArray(report?.capabilities) ? report.capabilities : [],
    access: report?.access ?? null,
  };
}

/** Runs one CLI command to completion. Never rejects. */
function runAgent(args, { cli, home, execPath = process.execPath, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    execFile(
      execPath,
      [cli, ...args],
      { env: agentEnv(home), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

async function computerStatus(options) {
  const result = await runAgent(['status', '--json'], options);
  try {
    return computerStatusFrom(JSON.parse(result.stdout));
  } catch {
    return unavailable((result.stderr || result.stdout || 'agent status failed').trim().slice(-500));
  }
}

/** One shape for every computer_status answer, so callers never branch on it. */
function unavailable(error) {
  return { available: false, paired: false, paused: false, serviceInstalled: false, serviceActive: false, needsRepair: false, capabilities: [], access: null, error };
}

/**
 * Pairs this machine and installs the service: `connect --json --daemon`.
 * Resolves `{ ok: true, tunnelId, existing? }` once the service is installed,
 * `{ ok: false, error }` otherwise. `onChallenge(url)` shows the approval page.
 * Aborting `signal` stops the agent and resolves `cancelled`.
 */
function connectComputer({ cli, home, apiUrl, projectId, reauth, onChallenge, onApproved, signal, execPath = process.execPath }) {
  return new Promise((resolve) => {
    const args = [cli, 'connect', '--json', '--daemon', '--api-url', apiUrl];
    if (projectId) args.push('--project-id', projectId);
    if (reauth) args.push('--reauth');
    const child = spawn(execPath, args, { env: agentEnv(home), stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
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
  if (status.paused) return 'Computer access paused';
  if (status.state === 'online') return 'Computer connected';
  if (!status.serviceActive) return 'Computer service stopped';
  if (status.state === 'connecting') return 'Computer connecting…';
  if (status.state === 'rejected') return 'Computer needs to reconnect';
  if (status.state === 'standby') return 'Computer in use by another Kortix app or terminal';
  return 'Computer offline';
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Tray menu (A5). `actions` are the click handlers; this stays a plain
 * template so the item list is tested without Electron.
 */
function trayMenuTemplate(status, { openAtLogin, loginItemSupported, now = Date.now() }, actions) {
  const access = status?.access ?? { mode: 'always', grantedUntil: null, keepAwake: false, keepAwakeSupported: false };
  const canKeepAwake = access.keepAwakeSupported === true;
  const paused = Boolean(status?.paired && status.paused);
  const granted = access.mode === 'ask' && access.grantedUntil && Date.parse(access.grantedUntil) > now;
  const mode = (id, label) => ({ label, type: 'radio', checked: access.mode === id, click: () => actions.setMode(id) });
  return [
    { id: 'status', label: statusLabel(status), enabled: false },
    { type: 'separator' },
    { id: 'open', label: 'Open Kortix', click: actions.open },
    { type: 'separator' },
    {
      id: 'access',
      label: 'Access',
      submenu: [mode('ask', 'Ask each time'), mode('always', 'Always allowed'), mode('off', 'Off')],
    },
    ...(granted
      ? [
          { id: 'grant', label: `Allowed until ${clock(access.grantedUntil)}`, enabled: false },
          { id: 'revoke', label: 'Revoke now', click: actions.revoke },
        ]
      : []),
    canKeepAwake
      ? { id: 'keepAwake', label: 'Keep this computer awake while plugged in', type: 'checkbox', checked: access.keepAwake, click: actions.toggleKeepAwake }
      : { id: 'keepAwake', label: 'Keep awake: not available on Windows yet', enabled: false },
    {
      id: 'pause',
      label: paused ? 'Resume computer access' : 'Pause computer access',
      enabled: Boolean(status?.paired),
      click: paused ? actions.resume : actions.pause,
    },
    { id: 'logs', label: 'Show logs', click: actions.logs },
    { type: 'separator' },
    ...(loginItemSupported
      ? [{ id: 'login', label: 'Open at login', type: 'checkbox', checked: openAtLogin, click: actions.toggleLogin }]
      : []),
    { id: 'disconnect', label: 'Disconnect this computer…', enabled: Boolean(status?.paired), click: actions.disconnect },
    { type: 'separator' },
    {
      id: 'quit',
      label: status?.paired && !paused ? 'Quit Kortix (your computer stays connected)' : 'Quit Kortix',
      click: actions.quit,
    },
  ];
}

/** Keep the app alive in the tray, instead of quitting, when a computer is paired. */
function keepRunningInTray(status) {
  return status?.paired === true;
}

module.exports = {
  accessArgs,
  accessPrompt,
  agentCliPath,
  agentEnv,
  agentHome,
  answerArgs,
  backendFromRuntimeConfig,
  checkPageApiUrl,
  computerSetupMissing,
  computerStatus,
  computerStatusFrom,
  connectComputer,
  desktopAppRecord,
  effectiveHome,
  ensureDevAgentCli,
  isProjectId,
  keepRunningInTray,
  ndjsonParser,
  requestToPrompt,
  runAgent,
  sha8,
  statusLabel,
  trayMenuTemplate,
  unavailable,
  widenPrompt,
  writePrivateJson,
};
