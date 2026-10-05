// Kortix Capture inside the desktop app: the engine from kortix-ai/capture
// (scripts/fetch-capture-engine.js), run as children of this app so macOS
// attributes Screen Recording, Accessibility and the Microphone to Kortix. No
// Electron imports here: every rule is unit-tested with plain bun.
//
// The engine owns recording, the library, sign-in (RFC 8628) and sync. This
// module finds its binaries, builds its environment, parses its output, and
// decides which of its processes run. The engine's own tray (`kortix-tray`)
// is never shipped or started: Capture's tray section is capture-tray.js.
//
// Capture is its own product: nothing here imports the computer agent's
// modules (computer.js, computer-tray.js, packages/agent-tunnel).

const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
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

const DEFAULT_DESKTOP = { on: false, actions: true };

function readDesktop(library) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(library, 'desktop.json'), 'utf8'));
    return { on: raw.on === true, actions: raw.actions !== false };
  } catch {
    return { ...DEFAULT_DESKTOP };
  }
}

const writeDesktop = (library, state) => writePrivateJson(library, 'desktop.json', state);

/* ─── Sign-in ──────────────────────────────────────────────────────────── */

/**
 * `sync setup --provider kortix --no-browser` prints to stderr:
 *   Approve this computer in your browser:
 *     <verification_uri_complete>
 *   Code: <user_code>
 */
function parseSignInChallenge(text) {
  const code = /^Code:\s*(\S+)\s*$/m.exec(String(text));
  const url = /^\s+(https?:\/\/\S+)\s*$/m.exec(String(text));
  return code && url ? { userCode: code[1], verificationUrl: url[1] } : null;
}

/** The engine's last `Error:` line, without the prefix; else `fallback`. */
function lastError(stderr, fallback) {
  const line = String(stderr || '').split('\n').reverse().find((l) => l.startsWith('Error:'));
  return line ? line.replace(/^Error:\s*/, '').slice(0, 500) : fallback;
}

/**
 * Runs the engine's sign-in. `onChallenge({ userCode, verificationUrl })`
 * fires once the code exists; the promise resolves when the CLI exits:
 * `{ ok: true, deviceId, prefix }` or `{ ok: false, error }`.
 */
function signIn({ paths, env, issuer, onChallenge, signal, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const child = spawnFn(
      paths.capture,
      ['--json', 'sync', 'setup', '--provider', 'kortix', '--issuer', issuer, '--no-browser'],
      { env, stdio: ['ignore', 'pipe', 'pipe'], signal },
    );
    let stdout = '';
    let stderr = '';
    let challenged = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
      const challenge = !challenged && parseSignInChallenge(stderr);
      if (challenge) {
        challenged = true;
        onChallenge?.(challenge);
      }
    });
    child.on('error', (error) => resolve({ ok: false, error: error.name === 'AbortError' ? 'cancelled' : error.message }));
    child.on('close', (code) => {
      if (signal?.aborted) return resolve({ ok: false, error: 'cancelled' });
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          return resolve({ ok: true, deviceId: result.device_id, prefix: result.prefix });
        } catch {
          /* fall through */
        }
      }
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

/* ─── Supervision ──────────────────────────────────────────────────────── */

/**
 * `kortix-backend --service` has no `--supervised` mode, so it runs under this
 * guard (`<app binary> -e GUARD <file> <args…>` with ELECTRON_RUN_AS_NODE=1).
 * The app holds the guard's stdin: when the app quits or crashes the pipe
 * closes and the guard ends the service. No action recorder outlives Kortix.
 * ponytail: drop the guard once the engine's backend takes `--supervised`.
 */
const GUARD = `
const { spawn } = require('node:child_process');
const [file, ...args] = process.argv.slice(1);
const child = spawn(file, args, { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 5000).unref();
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** A child that ran this long counts as healthy: its next crash restarts fast. */
const HEALTHY_AFTER_MS = 60_000;
/** Crashes in a row after which the status says so. Restarts continue. */
const CRASH_LOOP = 5;

/** 2 s, doubling to 60 s (the engine's own tray uses the same curve). */
function restartDelay(crashes) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, crashes - 1));
}

/**
 * Which engine processes should run. The recorder (screen, audio, and the
 * library's sync) runs while Capture is on and signed in. The action service
 * runs beside it while the person's Actions switch is on and the project's
 * policy allows actions. A refused device (revoked, project flag off) runs
 * nothing until it signs in again.
 */
function desiredChildren({ available, desktop, signedIn, signInRequired, policy }) {
  const recorder = Boolean(available && desktop.on && signedIn && !signInRequired);
  return { recorder, actions: recorder && desktop.actions && policy?.layers?.actions !== false };
}

/**
 * Keeps one process running while wanted: restart on exit with backoff, stop
 * with SIGTERM then SIGKILL after `killAfterMs`. Timers and the clock are
 * injectable for tests. `start()` returns a ChildProcess-like emitter.
 */
function supervise({ name, start, onChange = () => {}, now = Date.now, timers = { setTimeout, clearTimeout }, killAfterMs = 5_000 }) {
  let child = null;
  let wanted = false;
  let crashes = 0;
  let startedAt = 0;
  let timer = null;
  let lastExit = null;

  let restarting = false;

  function launch() {
    timer = null;
    if (!wanted || child) return;
    startedAt = now();
    try {
      child = start();
    } catch (error) {
      child = null;
      lastExit = { code: null, error: error instanceof Error ? error.message : String(error) };
      return scheduleRestart();
    }
    const current = child;
    current.on('error', (error) => {
      lastExit = { code: null, error: error.message };
    });
    current.on('exit', (code, signal) => {
      if (child !== current) return;
      child = null;
      lastExit = { code, signal, error: lastExit?.error };
      if (!wanted) return onChange();
      if (restarting) {
        restarting = false;
        return launch();
      }
      crashes = now() - startedAt >= HEALTHY_AFTER_MS ? 1 : crashes + 1;
      console.warn(`[kortix] capture ${name} exited (code ${code}, signal ${signal}); restart #${crashes}`);
      scheduleRestart();
    });
    onChange();
  }

  /** SIGTERM, then SIGKILL after `killAfterMs` if it is still there. */
  function terminate(current) {
    current.kill('SIGTERM');
    const force = timers.setTimeout(() => {
      if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL');
    }, killAfterMs);
    current.once('exit', () => timers.clearTimeout(force));
  }

  function scheduleRestart() {
    if (!timer && wanted) timer = timers.setTimeout(launch, restartDelay(crashes));
    onChange();
  }

  return {
    run() {
      if (wanted) return;
      wanted = true;
      crashes = 0;
      launch();
    },
    /** Replace a running child now (macOS applies a new grant only to a new process). */
    restart() {
      if (!wanted || !child || restarting) return;
      restarting = true;
      terminate(child);
    },
    stop() {
      wanted = false;
      restarting = false;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      if (!child) return onChange();
      terminate(child);
    },
    state: () => ({
      wanted,
      running: Boolean(child),
      pid: child?.pid ?? null,
      crashes,
      crashLoop: crashes >= CRASH_LOOP,
      lastExit,
    }),
  };
}

/* ─── The OS service (capture-service.js) ──────────────────────────────── */

/**
 * What the desktop app does to the Capture service, from the person's switch,
 * the sign-in, and `capture-service.js status`: `install` (missing, or the
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
  // Running but no heartbeat yet: the engine still reports `not_running`.
  else if (!recorder.running || !status?.recorder_running) state = 'starting';
  else state = status.effective_state || 'starting';
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
      actions: desktop.actions,
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
  permission_needed: 'Needs permission',
  not_recording: 'Not recording',
  starting: 'Starting…',
  crashed: 'Stopped after repeated crashes',
  off: 'Off',
  stopped: 'Stopped',
  signInRequired: 'Signed out',
  signedOut: 'Not set up',
};

/** Capture's state for the tray: `Recording · Screen, Actions`. */
function captureLabel(view) {
  const word = STATE_WORDS[view.state] || 'Not recording';
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
 * apart from the computer agent's.
 */
function captureTrayItems(view, actions) {
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
            : { id: 'capture-pause', label: 'Pause for 1 hour', click: actions.pause },
        ]
      : []),
    { id: 'capture-open', label: view.signInRequired ? 'Sign in again…' : 'Open Capture…', click: actions.open },
    { id: 'capture-logs', label: 'Show logs', click: actions.logs },
  ];
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
  sha8,
  writePrivateJson,
  CRASH_LOOP,
  GUARD,
  PERMISSION_PANES,
  captureLabel,
  captureStatusFrom,
  captureKeepsRunning,
  captureTrayItems,
  desiredChildren,
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
  parseSignInChallenge,
  accountFromPrefix,
  readDesktop,
  restartDelay,
  runEngine,
  serviceAction,
  signIn,
  supervise,
  writeDesktop,
};
