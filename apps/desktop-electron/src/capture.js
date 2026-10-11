// Kortix Capture inside the desktop app: the engine from kortix-ai/capture
// (scripts/fetch-capture-engine.js). No Electron imports here: every rule is
// unit-tested with plain bun.
//
// The engine's CLI owns recording, the library, sign-in (RFC 8628), sync and
// the 24/7 OS service (`kortix-capture login|start|stop|logout|service`). This
// app only bundles it, asks macOS for the grants, passes itself as the
// service's host (so the grants belong to Kortix: the OS starts this binary,
// which runs the engine as its child), and renders `--json` output. The
// engine's own tray (`kortix-tray`) is never shipped or started: Capture's
// tray section is capture-tray.js.
//
// Capture is its own product: nothing here imports the computer agent's
// modules (computer.js, computer-tray.js, packages/agent-tunnel).

const { execFile, execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sha8 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

/** `<dir>/<name>` as mode-0600 JSON, written atomically (temp file, then rename). */
function writePrivateJson(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const isLoopbackHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

/**
 * The instance's backend URL from its `/api/runtime-config` script
 * (`__KORTIX_RUNTIME_CONFIG={...BACKEND_URL...}`), resolved against the app
 * origin: https, or http on localhost only; no credentials, query or fragment.
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

const exe = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);

/** The files the app ships per platform. `kortix-tray` is deliberately absent. */
function engineFiles(platform) {
  if (platform === 'darwin') {
    return ['kortix-capture', 'kortix-capture-engine', 'kortix-backend', 'libonnxruntime.1.23.2.dylib', 'privacy-runtime-notices.txt'];
  }
  if (platform === 'win32') {
    return ['kortix-capture.exe', 'kortix-capture-engine.exe', 'kortix-backend.exe', 'onnxruntime.dll', 'privacy-runtime-notices.txt'];
  }
  return ['kortix-capture', 'kortix-capture-engine', 'kortix-backend'];
}

/**
 * Where the engine binaries are. `KORTIX_CAPTURE_ENGINE_DIR` (a local engine
 * build) wins; packaged: `Resources/capture`; dev: the staged vendor dir.
 */
function engineDir({ isPackaged, resourcesPath, env = process.env, platform = process.platform }) {
  if (env.KORTIX_CAPTURE_ENGINE_DIR) return env.KORTIX_CAPTURE_ENGINE_DIR;
  return isPackaged
    ? path.join(resourcesPath, 'capture')
    : path.join(__dirname, '..', 'vendor', 'capture', platform);
}

function enginePaths(dir, platform = process.platform) {
  return {
    capture: path.join(dir, exe('kortix-capture', platform)),
    engine: path.join(dir, exe('kortix-capture-engine', platform)),
    backend: path.join(dir, exe('kortix-backend', platform)),
  };
}

/** One library per backend, like the agent home: a sign-in never crosses instances. */
function libraryDir(userData, apiOrigin) {
  return path.join(userData, 'capture', sha8(apiOrigin));
}

/** The issuer is the API origin plus its path, without the `/v1` the engine adds itself. */
function issuerFromBackend(backendUrl) {
  return backendUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** `<account id>` (Capture's tenant) from the prefix the issuer returned (`orgs/<account>`). */
function accountFromPrefix(prefix) {
  const match = /^orgs\/([0-9a-f-]{36})$/i.exec(String(prefix || '').replace(/\/+$/, ''));
  return match ? match[1] : null;
}

/**
 * The engine's config file (KORTIX_CONFIG). An empty update key turns the
 * engine's self-update off: this app ships the engine and updates it with
 * itself, and a self-patched binary would break the app's signature.
 */
function engineConfigYaml(library) {
  return [
    '# Written by the Kortix desktop app on every start; edits are replaced.',
    'updates:',
    '  public_key: ""',
    'recordings:',
    `  directory: ${JSON.stringify(path.join(library, 'recordings'))}`,
    '',
  ].join('\n');
}

function engineEnv({ library, paths, base = process.env }) {
  return {
    ...base,
    KORTIX_CAPTURE_DIR: library,
    KORTIX_CAPTURE_ENGINE: paths.engine,
    KORTIX_CONFIG: path.join(library, 'engine-config.yaml'),
    // The engine's tray is not running; nothing may install its login entry.
    KORTIX_TRAY_AUTO_LAUNCH: '0',
    // The action service's local API: any free port, so a standalone Kortix
    // Capture install on 16193 is never displaced.
    LOCAL_PORT: '0',
    // The device token in a mode-0600 file in the library, not the Keychain:
    // a Keychain item belongs to the code signature that wrote it, and an app
    // update re-signs the engine, so macOS would prompt or refuse after every
    // update. The token is device-scoped and revocable in Kortix.
    KORTIX_CAPTURE_KEY_STORE: 'file',
  };
}

/* ─── desktop.json: what the person chose in this app ─────────────────── */

/** Only the on switch: which layers record is the account policy's call. */
const DEFAULT_DESKTOP = { on: false };

function readDesktop(library) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(library, 'desktop.json'), 'utf8'));
    return { on: raw.on === true };
  } catch {
    return { ...DEFAULT_DESKTOP };
  }
}

const writeDesktop = (library, state) => writePrivateJson(library, 'desktop.json', state);

/* ─── Sign-in ──────────────────────────────────────────────────────────── */

/** The engine's last `Error:` line, without the prefix; else `fallback`. */
function lastError(stderr, fallback) {
  const line = String(stderr || '').split('\n').reverse().find((l) => l.startsWith('Error:'));
  return line ? line.replace(/^Error:\s*/, '').slice(0, 500) : fallback;
}

/**
 * Runs `kortix-capture --json login`: one JSON line per event on stdout,
 * `challenge` (the code) then `signed_in`. `onChallenge({ userCode,
 * verificationUrl })` fires once the code exists; the promise resolves when
 * the CLI exits: `{ ok: true, deviceId, prefix }` or `{ ok: false, error }`.
 * The CLI holds the library's sign-in marker while it runs, so the service waits.
 */
function signIn({ paths, env, issuer, onChallenge, signal, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const child = spawnFn(paths.capture, ['--json', 'login', '--issuer', issuer, '--no-browser'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let buffer = '';
    let stderr = '';
    let done = null;
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === 'challenge') onChallenge?.({ userCode: event.user_code, verificationUrl: event.verification_uri_complete });
        if (event.event === 'signed_in') done = event;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on('error', (error) => resolve({ ok: false, error: error.name === 'AbortError' ? 'cancelled' : error.message }));
    child.on('close', (code) => {
      if (signal?.aborted) return resolve({ ok: false, error: 'cancelled' });
      if (code === 0 && done) return resolve({ ok: true, deviceId: done.device_id, prefix: done.prefix });
      resolve({ ok: false, error: lastError(stderr, `sign-in exited with code ${code}`) });
    });
  });
}

/** Runs one engine command; resolves `{ code, stdout, stderr }`, never rejects. */
function runEngine(file, args, { env, timeoutMs = 30_000, execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    execFileFn(file, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function engineJson(file, args, options) {
  const result = await runEngine(file, ['--json', ...args], options);
  if (result.code !== 0) throw new Error(lastError(result.stderr, `kortix-capture ${args.join(' ')} failed`));
  return JSON.parse(result.stdout);
}

/* ─── The CLI-owned service ───────────────────────────────────────────── */

/**
 * What the OS service's host runs: `<this binary> -e SERVICE_SHIM <engine>
 * service run` with ELECTRON_RUN_AS_NODE=1. It keeps the engine's supervisor
 * as its child, so macOS holds Kortix responsible for its grants, and ends
 * with it: launchd / systemd / Task Scheduler restart the pair.
 */
const SERVICE_SHIM = `
const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

/** Engine variables the service needs beyond the library (which the CLI sets itself). */
const SERVICE_ENV_KEYS = ['KORTIX_CAPTURE_ENGINE', 'KORTIX_CONFIG', 'KORTIX_TRAY_AUTO_LAUNCH', 'LOCAL_PORT', 'KORTIX_CAPTURE_KEY_STORE'];

/**
 * `start` / `service install` arguments that make this app the service's host.
 * `bundleId` (macOS) lets Login Items and the "can run in the background"
 * notice name the app instead of its executable.
 */
function serviceHostArgs({ host, env, bundleId = null }) {
  const args = ['--host', host, '--host-arg', '-e', '--host-arg', SERVICE_SHIM, '--host-env', 'ELECTRON_RUN_AS_NODE=1'];
  for (const key of SERVICE_ENV_KEYS) if (env[key] !== undefined) args.push('--host-env', `${key}=${env[key]}`);
  if (bundleId) args.push('--host-bundle-id', bundleId);
  return args;
}

const readBundleId = (plist) =>
  execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { encoding: 'utf8' });

/** The bundle id of an app binary (`<X>.app/Contents/MacOS/<x>`), else null. */
function bundleIdOf(execPath, read = readBundleId) {
  const contents = path.dirname(path.dirname(execPath));
  if (path.basename(path.dirname(execPath)) !== 'MacOS' || path.basename(contents) !== 'Contents') return null;
  try {
    return read(path.join(contents, 'Info.plist')).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Removes the service this app installed before the engine's CLI owned it:
 * `ai.kortix.desktop.capture.<sha8(library)>` started `/bin/sh`, so macOS
 * named it "sh". True when it removed one.
 */
function removeLegacyService({ library, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run }) {
  // Checked at every start, not once: an older copy of the app, opened later, installs it again.
  const label = `ai.kortix.desktop.capture.${sha8(path.resolve(library))}`;
  const file =
    platform === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
      : platform === 'linux'
        ? path.join(home, '.config', 'systemd', 'user', `${label}.service`)
        : null;
  if (platform === 'win32') {
    // A Scheduled Task has no file to check: delete it; a missing task exits non-zero.
    return run('schtasks.exe', ['/Delete', '/TN', label, '/F'])?.status === 0;
  }
  if (!file || !fs.existsSync(file)) return false;
  if (platform === 'darwin') run('launchctl', ['bootout', `gui/${uid}/${label}`]);
  else run('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
  fs.rmSync(file, { force: true });
  return true;
}

/** `kortix-capture --json service status` → the shape serviceAction and the page read. */
function serviceFromCli(v) {
  return { installed: v?.installed === true, active: v?.active === true, enabled: v?.enabled !== false, upToDate: v?.up_to_date !== false, heartbeat: v?.heartbeat ?? null };
}

/** Crashes in a row after which the status says so. The service keeps restarting. */
const CRASH_LOOP = 5;

/** The service heartbeat's children, as captureStatusFrom reads them. */
function childrenFromHeartbeat(heartbeat) {
  const child = (c) => ({ running: c?.running === true, crashLoop: (c?.crashes ?? 0) >= CRASH_LOOP, lastExit: c?.last_exit ? { error: c.last_exit } : null });
  return { recorder: child(heartbeat?.recorder), actions: child(heartbeat?.actions) };
}

/* ─── The OS service (`kortix-capture start|stop|service`) ───────────────── */

/**
 * What the desktop app does to the Capture service, from the person's switch,
 * the sign-in, and `kortix-capture service status`: `install` (missing, or the
 * unit points at an old app path: an update or a move), `resume` (disabled),
 * `repair` (installed and enabled, but not running: reinstall, throttled),
 * `pause` (Capture off: disabled, so login does not start it), `uninstall`
 * (signed out), or null. `explicit` is a person's action (the switch, a
 * sign-in, Record); without it only `install` after an update, `pause` and
 * `uninstall` happen.
 */
function serviceAction({ desktopOn, signedIn, signInRequired, service, explicit = false }) {
  const installed = service?.installed === true;
  if (!signedIn && !signInRequired) return installed ? 'uninstall' : null;
  if (!desktopOn) return installed && service.enabled !== false ? 'pause' : null;
  // A launch or a poll never starts what someone stopped (launchctl disable,
  // a removed unit, a killed service): it only rewrites an enabled unit
  // after an app update or move. Starting it again takes a person's action.
  if (!explicit) return installed && service.enabled !== false && service.upToDate === false ? 'install' : null;
  if (!installed || service.upToDate === false) return 'install';
  if (service.enabled === false) return 'resume';
  if (!service.heartbeat?.running && service.active !== true) return 'repair';
  return null;
}

/* ─── Status ───────────────────────────────────────────────────────────── */

const PERMISSION_KEYS = ['screen', 'accessibility', 'microphone', 'input_monitoring'];

/** The permission keys macOS granted, from `kortix-capture --json permissions`. */
function grantedPermissions(permissions) {
  return permissions ? PERMISSION_KEYS.filter((key) => permissions[key] === true || permissions[key] === 'granted') : [];
}

/** The page's view of them; `inputMonitoring` only when the engine reports it. */
function permissionView(permissions) {
  const granted = grantedPermissions(permissions);
  return {
    screen: granted.includes('screen'),
    accessibility: granted.includes('accessibility'),
    microphone: granted.includes('microphone'),
    ...('input_monitoring' in permissions ? { inputMonitoring: granted.includes('input_monitoring') } : {}),
  };
}

/** The operator policy in force, from `sync status` (`{ source, fetched_at_ms, policy }`). */
function policyOf(sync) {
  return sync?.policy?.policy || null;
}

/**
 * The `capture_status` answer, from the engine's `status`, `sync status` and
 * `permissions` JSON plus this app's choices and its children.
 */
function captureStatusFrom({ available, error, desktop, status, sync, permissions, children, serviceStopped = false }) {
  if (!available) return { available: false, error: error || 'Kortix Capture is not part of this build.' };
  const kortix = sync?.kortix || {};
  const signedIn = kortix.signed_in === true;
  const signInRequired = kortix.sign_in_required === true;
  const policy = policyOf(sync);
  const recorder = children?.recorder || {};
  let state;
  if (signInRequired) state = 'signInRequired';
  else if (!signedIn) state = 'signedOut';
  else if (!desktop.on) state = 'off';
  else if (serviceStopped) state = 'stopped';
  else if (recorder.crashLoop) state = 'crashed';
  // Running but no heartbeat yet.
  else if (!recorder.running || !status?.recorder_running) state = 'starting';
  // The engine's status.json words: recording, paused, permission_missing, not_recording.
  else state = status.state || 'starting';
  return {
    available: true,
    on: desktop.on,
    signedIn,
    signInRequired,
    accountId: accountFromPrefix(kortix.prefix),
    deviceId: kortix.device_id || null,
    memberEmail: kortix.member_email || null,
    state,
    reason: status?.inactive_reason || null,
    layers: {
      screen: status?.recording_enabled !== false,
      actions: policy?.layers?.actions !== false,
      audio: status?.audio_enabled === true,
    },
    policy: policy
      ? {
          layers: { screen: true, actions: true, audio: true, ...(policy.layers || {}) },
          notice: typeof policy.notice === 'string' ? policy.notice : '',
          paused: policy.recording?.paused === true,
        }
      : null,
    pausedUntilMs: status?.paused_until_ms ?? null,
    permissions: permissions ? permissionView(permissions) : null,
    sync: {
      state: sync?.state?.state || 'off',
      pending: sync?.state?.pending ?? 0,
      lastUploadMs: sync?.state?.last_upload_ms ?? null,
      error: sync?.state?.last_error || null,
    },
    ...(recorder.lastExit?.error ? { error: recorder.lastExit.error } : {}),
  };
}

const STATE_WORDS = {
  recording: 'Recording',
  paused: 'Paused',
  permission_missing: 'Needs permission',
  not_recording: 'Not recording',
  starting: 'Starting…',
  crashed: 'Stopped after repeated crashes',
  off: 'Off',
  stopped: 'Stopped',
  signInRequired: 'Signed out',
  signedOut: 'Not set up',
};

/** Reasons that stop recording without anyone pausing it (the engine's `inactive_reason`). */
const REASON_WORDS = {
  locked: 'Screen locked',
  excluded_app: 'Excluded app in front',
  excluded_domain: 'Excluded app in front',
  private_browsing: 'Excluded app in front',
  unknown_bundle: 'Excluded app in front',
};

/** Capture's state for the tray: `Recording · Screen, Actions`. */
function captureLabel(view) {
  const stopped = view.state === 'paused' || view.state === 'not_recording';
  const word = (stopped && REASON_WORDS[view.reason]) || STATE_WORDS[view.state] || 'Not recording';
  if (view.state !== 'recording') return word;
  const layers = ['screen', 'actions', 'audio']
    .filter((key) => view.layers[key] && view.policy?.layers?.[key] !== false)
    .map((key) => key[0].toUpperCase() + key.slice(1));
  return `${word}${layers.length ? ` · ${layers.join(', ')}` : ''}`;
}

/** Capture keeps recording after Quit: it is on here and its service was not stopped. */
function captureKeepsRunning(view) {
  return Boolean(view?.available && view.on && view.signedIn && view.state !== 'stopped');
}

/**
 * Capture's own tray menu (capture-tray.js); empty while this build has no
 * engine or Capture is not set up on this computer. Its own menu bar item,
 * apart from the computer agent's. `frontmost` is the app the person was in
 * when they opened the menu (`frontmostFrom`), or null.
 */
function captureTrayItems(view, actions, frontmost = null) {
  if (!view?.available || (!view.signedIn && !view.signInRequired)) return [];
  const paused = view.state === 'paused' || Boolean(view.pausedUntilMs && view.pausedUntilMs > Date.now());
  const on = Boolean(view.on && view.signedIn) && view.state !== 'stopped';
  return [
    { id: 'capture-status', label: captureLabel(view), enabled: false },
    ...(view.policy?.notice ? [{ id: 'capture-notice', label: `Notice: ${view.policy.notice}`.slice(0, 80), enabled: false }] : []),
    { type: 'separator' },
    ...(on
      ? [
          paused
            ? { id: 'capture-resume', label: 'Resume recording', click: actions.resume }
            : { id: 'capture-pause', label: 'Pause recording for 1 hour', click: actions.pause },
          ...(frontmost
            ? [{ id: 'capture-exclude-front', label: `Exclude “${frontmost.name}”`, click: () => actions.exclude(frontmost) }]
            : []),
          { type: 'separator' },
        ]
      : []),
    ...(view.signedIn ? [{ id: 'capture-settings', label: 'Kortix Capture settings…', click: actions.settings }] : []),
    ...(view.signedIn || !view.signInRequired
      ? [{ id: 'capture-open', label: 'Open Kortix Capture…', click: actions.open }]
      : [{ id: 'capture-open', label: 'Sign in again…', click: actions.open }]),
    { id: 'capture-logs', label: 'Show logs', click: actions.logs },
    ...(on ? [{ type: 'separator' }, { id: 'capture-stop', label: 'Stop recording…', click: actions.stop }] : []),
  ];
}

/* ─── Exclusions ─────────────────────────────────────────────────────── */

/**
 * The app in front, from `lsappinfo info -only bundleid -only name <front>`
 * (macOS). A menu bar click does not activate Kortix, so this is the person's
 * app. Kortix itself (`selfBundleId`) is none: excluding it would hide nothing.
 */
function frontmostFrom(output, selfBundleId) {
  const field = (key) => new RegExp(`"${key}"="([^"]*)"`).exec(String(output))?.[1];
  const bundleId = field('CFBundleIdentifier');
  if (!bundleId || bundleId === selfBundleId) return null;
  // Some apps prefix their display name with a bidi mark (U+200E/F, U+202A–E, U+2066–9).
  const name = (field('LSDisplayName') ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return { bundleId, name: name || bundleId };
}

/** A domain from what a person types or pastes; null when it is not one. */
function normalizeDomain(input) {
  let host = String(input ?? '').trim().toLowerCase();
  if (!host) return null;
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

const APP_ID = /^[A-Za-z0-9][\w.-]{0,199}$/;
const GROUP_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** `capture_exclude` → the engine's `exclude` / `include` arguments. Throws on anything malformed. */
function excludeArgs({ kind, id, on, frontmost = false } = {}) {
  const verb = on ? 'exclude' : 'include';
  switch (kind) {
    case 'app':
      if (frontmost) {
        if (!on) throw new Error('Only the front app can be excluded, not included.');
        return [verb, 'app', '--frontmost'];
      }
      if (typeof id !== 'string' || !APP_ID.test(id)) throw new Error('Not an app id.');
      return [verb, 'app', id];
    case 'domain': {
      const domain = normalizeDomain(id);
      if (!domain) throw new Error('Not a website address.');
      return [verb, 'domain', domain];
    }
    case 'group':
      if (typeof id !== 'string' || !GROUP_ID.test(id)) throw new Error('Not a category.');
      return [verb, 'group', id];
    case 'private-browsing':
      return [verb, 'private-browsing'];
    default:
      throw new Error(`Unknown exclusion kind: ${kind}`);
  }
}

/** System Settings panes for the engine's permissions (macOS). */
const PERMISSION_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

module.exports = {
  backendFromRuntimeConfig,
  bundleIdOf,
  removeLegacyService,
  sha8,
  writePrivateJson,
  CRASH_LOOP,
  PERMISSION_PANES,
  SERVICE_SHIM,
  captureLabel,
  captureStatusFrom,
  captureKeepsRunning,
  captureTrayItems,
  excludeArgs,
  frontmostFrom,
  normalizeDomain,
  childrenFromHeartbeat,
  policyOf,
  engineConfigYaml,
  engineDir,
  engineEnv,
  engineFiles,
  engineJson,
  grantedPermissions,
  enginePaths,
  issuerFromBackend,
  lastError,
  libraryDir,
  accountFromPrefix,
  readDesktop,
  runEngine,
  serviceAction,
  serviceFromCli,
  serviceHostArgs,
  signIn,
  writeDesktop,
};
