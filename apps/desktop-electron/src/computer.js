// This computer as a Kortix account: the bundled @kortix/agent-tunnel CLI,
// run with this app's own binary as Node (ELECTRON_RUN_AS_NODE=1). No Electron
// imports here, so every rule below is unit-tested with plain bun.
//
// The CLI owns pairing, credentials, the OS service, and state.json. This
// module only spawns it, parses its NDJSON events, and reads its files.

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

/**
 * The macOS grants this machine's approved access still needs, in the order
 * setup asks for them. Files (`filesystem`) need the protected folders
 * (Desktop, Documents, Downloads); Computer Use (`desktop`) needs
 * Accessibility and Screen Recording. All of them belong to Kortix: the agent
 * runs as this app's binary and the bundled driver runs embedded under it.
 * `grants` is null off macOS.
 *
 * @param {string | null} home
 * @param {{ accessibility: boolean, screenRecording: boolean, files: boolean | null } | null} grants
 * @returns {('files' | 'accessibility' | 'screenRecording')[]}
 */
function computerSetupMissing(home, grants) {
  if (!grants) return [];
  let capabilities = [];
  try {
    capabilities = JSON.parse(fs.readFileSync(path.join(effectiveHome(home), 'config.json'), 'utf8')).enabledCapabilities ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(capabilities)) return [];
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

/* ─── Access control (contract v2 §A) ───────────────────────────────────
   Same file and rules as packages/agent-tunnel/src/agent/access.ts: the app
   writes the owner's answers, the agent enforces them. */

const ACCESS_MODES = ['ask', 'always', 'off'];
const MAX_GRANT_MINUTES = 24 * 60;
const DENY_MS = 10 * 60_000;
/** A request older than this is stale: its call has long returned. */
const REQUEST_FRESH_MS = 60_000;
const isoOrNull = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

function readAccess(home) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(effectiveHome(home), 'access.json'), 'utf8');
  } catch {
    return { mode: 'always', grantedUntil: null, deniedUntil: null, keepAwake: false };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      mode: ACCESS_MODES.includes(parsed.mode) ? parsed.mode : 'ask',
      grantedUntil: isoOrNull(parsed.grantedUntil),
      deniedUntil: isoOrNull(parsed.deniedUntil),
      keepAwake: parsed.keepAwake === true,
    };
  } catch {
    return { mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false };
  }
}

function writePrivateJson(home, name, value) {
  const dir = effectiveHome(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const writeAccess = (home, state) => writePrivateJson(home, 'access.json', state);

/** `computer_access_set` input applied to the current state. Throws on bad input. */
function nextAccess(current, input = {}, now = Date.now()) {
  const next = { ...current };
  if (input.mode !== undefined) {
    if (!ACCESS_MODES.includes(input.mode)) throw new Error(`mode must be one of ${ACCESS_MODES.join(', ')}`);
    // A grant or denial belongs to the mode it was given in: switching back
    // to "Ask each time" must ask again.
    if (input.mode !== current.mode) {
      next.grantedUntil = null;
      next.deniedUntil = null;
    }
    next.mode = input.mode;
  }
  if (input.grantMinutes !== undefined) {
    const minutes = Number(input.grantMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('grantMinutes must be a positive number');
    next.grantedUntil = new Date(now + Math.min(minutes, MAX_GRANT_MINUTES) * 60_000).toISOString();
    next.deniedUntil = null;
  }
  if (input.revoke === true) next.grantedUntil = null;
  // The page's answer to a pending request: the native prompt's "Deny".
  if (input.deny === true) {
    next.grantedUntil = null;
    next.deniedUntil = new Date(now + DENY_MS).toISOString();
  }
  if (input.keepAwake !== undefined) next.keepAwake = input.keepAwake === true;
  return next;
}

/** Same rule as the agent's decideAccess: 'run', 'off', 'denied', or 'ask'. */
function decideAccess(state, now = Date.now()) {
  if (state.mode === 'always') return 'run';
  if (state.mode === 'off') return 'off';
  if (state.deniedUntil && Date.parse(state.deniedUntil) > now) return 'denied';
  const granted = state.grantedUntil ? Date.parse(state.grantedUntil) : 0;
  return granted > now && granted - now <= MAX_GRANT_MINUTES * 60_000 ? 'run' : 'ask';
}

/**
 * True when `next` lets calls run that `current` does not: `always` from
 * another mode, or a grant that reaches further. Only the owner may do that,
 * in a native dialog; the page may only narrow access.
 */
function accessWidens(current, next, now = Date.now()) {
  if (next.mode === 'always') return current.mode !== 'always';
  if (next.mode !== 'ask') return false;
  const reach = (state) => (state.mode === 'ask' && decideAccess(state, now) === 'run' ? Date.parse(state.grantedUntil) : 0);
  return reach(next) > reach(current);
}

function readAccessRequest(home) {
  try {
    const request = JSON.parse(fs.readFileSync(path.join(effectiveHome(home), 'access-request.json'), 'utf8'));
    return typeof request?.id === 'string' ? request : null;
  } catch {
    return null;
  }
}

function freshRequest(home, now = Date.now()) {
  const request = readAccessRequest(home);
  return request && now - Date.parse(request.requestedAt) < REQUEST_FRESH_MS ? request : null;
}

function clearAccessRequest(home, id) {
  if (readAccessRequest(home)?.id === id) fs.rmSync(path.join(effectiveHome(home), 'access-request.json'), { force: true });
}

/** An answer covers every call that asked before it, not only the prompted one. */
function clearAccessRequestsUntil(home, answeredAt = Date.now()) {
  const request = readAccessRequest(home);
  if (request && !(Date.parse(request.requestedAt) > answeredAt)) {
    fs.rmSync(path.join(effectiveHome(home), 'access-request.json'), { force: true });
  }
}

const keepAwakeSupported = (platform) => platform === 'darwin' || platform === 'linux';

/** X5 `computer_access_get`. */
function accessView(home, platform = process.platform, now = Date.now()) {
  const request = freshRequest(home, now);
  return {
    ...readAccess(home),
    keepAwakeSupported: keepAwakeSupported(platform),
    pendingRequest: request ? { id: request.id, capability: request.capability, requestedAt: request.requestedAt } : null,
  };
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

/** The owner's confirmation when the page asks to widen access (computer_access_set). */
function widenPrompt(next, machineName) {
  const what =
    next.mode === 'always'
      ? 'every agent call without asking you first'
      : `every agent call until ${clock(next.grantedUntil)} without asking you first`;
  return {
    type: 'warning',
    title: `Allow Kortix to use ${machineName}?`,
    message: `Allow Kortix to use ${machineName}?`,
    detail: `This allows ${what}: files, the shell, and the screen and keyboard. You can revoke access at any time from the menu bar.`,
    buttons: ['Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  };
}

function answerAccess(current, response, now = Date.now()) {
  if (response === 0) return nextAccess(current, { grantMinutes: MAX_GRANT_MINUTES }, now);
  if (response === 1) return nextAccess(current, { grantMinutes: 60 }, now);
  return { ...current, grantedUntil: null, deniedUntil: new Date(now + DENY_MS).toISOString() };
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
 * The `computer_status` answer (X5), from `service-status --json` plus
 * state.json. `needsRepair` (R5): paired, not paused, and the service is
 * missing, stopped, stale, or runs another agent version than this app bundles.
 */
function computerStatusFrom(serviceStatus, state) {
  const paired = serviceStatus?.paired === true;
  const service = serviceStatus?.service || {};
  // Paused = disabled in the supervisor. Installed, enabled and not running is
  // "stopped", which repair fixes.
  const paused = service.installed === true && service.enabled === false;
  const live = paired && state && state.tunnelId === serviceStatus.tunnelId ? state : null;
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
      Boolean(live?.agentVersion && serviceStatus.version && live.agentVersion !== serviceStatus.version));
  return {
    available: true,
    paired,
    ...(paired ? { tunnelId: serviceStatus.tunnelId, apiUrl: serviceStatus.apiUrl, status: current, state: current } : {}),
    paused,
    serviceInstalled: service.installed === true,
    serviceActive: service.active === true,
    needsRepair,
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
  return { available: false, paired: false, paused: false, serviceInstalled: false, serviceActive: false, needsRepair: false, error };
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
    const child = spawn(execPath, args, { env: agentEnv(home), stdio: ['ignore', 'pipe', 'pipe'], signal });
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
function trayMenuTemplate(
  status,
  access,
  { openAtLogin, loginItemSupported, keepAwakeSupported: canKeepAwake, captureItems = [], now = Date.now() },
  actions,
) {
  const paired = Boolean(status?.paired);
  const paused = Boolean(paired && status.paused);
  const granted = access.mode === 'ask' && access.grantedUntil && Date.parse(access.grantedUntil) > now;
  const mode = (id, label) => ({ label, type: 'radio', checked: access.mode === id, click: () => actions.setMode(id) });
  // Capture alone (no paired computer): its items, without the computer's.
  const withComputer = paired || captureItems.length === 0;
  const computerItems = [
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
      enabled: paired,
      click: paused ? actions.resume : actions.pause,
    },
    { id: 'logs', label: 'Show logs', click: actions.logs },
  ];
  return [
    ...(withComputer ? [{ id: 'status', label: statusLabel(status), enabled: false }] : []),
    ...captureItems,
    { type: 'separator' },
    { id: 'open', label: 'Open Kortix', click: actions.open },
    ...(withComputer ? computerItems : []),
    { type: 'separator' },
    ...(loginItemSupported
      ? [{ id: 'login', label: 'Open at login', type: 'checkbox', checked: openAtLogin, click: actions.toggleLogin }]
      : []),
    ...(withComputer ? [{ id: 'disconnect', label: 'Disconnect this computer…', enabled: paired, click: actions.disconnect }] : []),
    { type: 'separator' },
    { id: 'quit', label: quitLabel(paired && !paused, captureItems.length > 0), click: actions.quit },
  ];
}

/** The computer agent and Capture are OS services: both keep running after Quit. */
function quitLabel(computerStays, captureRuns) {
  if (computerStays && captureRuns) return 'Quit Kortix (your computer and Capture keep running)';
  if (computerStays) return 'Quit Kortix (your computer stays connected)';
  if (captureRuns) return 'Quit Kortix (Capture keeps recording)';
  return 'Quit Kortix';
}

/** Keep the app alive in the tray, instead of quitting, when a computer is paired. */
function keepRunningInTray(status) {
  return status?.paired === true;
}

module.exports = {
  computerSetupMissing,
  accessPrompt,
  accessView,
  agentCliPath,
  agentEnv,
  agentHome,
  answerAccess,
  backendFromRuntimeConfig,
  checkPageApiUrl,
  accessWidens,
  clearAccessRequest,
  clearAccessRequestsUntil,
  computerStatus,
  computerStatusFrom,
  connectComputer,
  decideAccess,
  desktopAppRecord,
  effectiveHome,
  ensureDevAgentCli,
  freshRequest,
  isProjectId,
  keepAwakeSupported,
  keepRunningInTray,
  ndjsonParser,
  nextAccess,
  readAccess,
  readAgentState,
  runAgent,
  sha8,
  statusLabel,
  trayMenuTemplate,
  unavailable,
  widenPrompt,
  writeAccess,
  writePrivateJson,
};
