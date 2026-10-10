// The Kortix Capture service: an OS service (launchd LaunchAgent, systemd user
// unit, Windows Scheduled Task) that runs THIS file with the Kortix app's own
// binary as Node (ELECTRON_RUN_AS_NODE=1). It keeps
// recording while the app is quit or crashed and across reboots. The service
// supervises the engine as its own children, so the process macOS holds
// responsible for Screen Recording, Accessibility and the Microphone is the
// Kortix binary: the grants belong to Kortix.
//
// Built into one file (scripts/ensure-runtime.js → vendor/capture-service.js)
// and shipped outside the asar as Resources/capture-service/capture-service.js.
// The supervisors (launchd, systemd, Task Scheduler) are capture-os-service.js.
//
//   capture-service.js run                       the service itself
//   capture-service.js install|uninstall|pause|resume|stop|status [--json]
//   capture-service.js render                    the unit file install would write
//
// Environment: KORTIX_CAPTURE_DIR (the library, one per Kortix instance) and
// KORTIX_CAPTURE_ENGINE_DIR (the engine binaries). Both are baked into the
// unit, so a moved or updated app shows as `upToDate: false` and the desktop
// app reinstalls the service.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capture = require('./capture');
const { sha8, writePrivateJson } = capture;
const supervisors = require('./capture-os-service');

const TICK_MS = 30_000;
const PROBE_EVERY_MS = 10 * 60_000;
/** A heartbeat older than this means the service is not running. */
const HEARTBEAT_STALE_MS = 90_000;
/** The desktop app writes this while a sign-in rewrites the library's sync settings. */
const SIGN_IN_MARKER = 'sign-in.pending';
const SIGN_IN_MAX_MS = 20 * 60_000;

/** Where the service's unit and logs live: one service per library. */
function servicePaths(library, home = os.homedir()) {
  const dir = path.resolve(library);
  const label = `ai.kortix.desktop.capture.${sha8(dir)}`;
  return {
    label,
    logDir: path.join(dir, 'logs'),
    launchdPlist: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    systemdUnit: path.join(home, '.config', 'systemd', 'user', `${label}.service`),
    windowsScript: path.join(dir, 'capture-service.ps1'),
  };
}

/** What the supervisor runs: the app binary as Node, this file, `run`. */
function runnerParts({ script, execPath, appImage, library, engineDir }) {
  return {
    command: appImage || execPath,
    args: [script, 'run'],
    env: { ELECTRON_RUN_AS_NODE: '1', KORTIX_CAPTURE_DIR: path.resolve(library), KORTIX_CAPTURE_ENGINE_DIR: engineDir },
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

/** `<library>/service.json`, with `running` false when stale or its pid is gone. */
function readHeartbeat(library, now = Date.now()) {
  try {
    const beat = JSON.parse(fs.readFileSync(path.join(library, 'service.json'), 'utf8'));
    return { ...beat, running: now - Date.parse(beat.updatedAt) < HEARTBEAT_STALE_MS && isAlive(beat.pid) };
  } catch {
    return { running: false };
  }
}

function signInPending(library, now = Date.now()) {
  try {
    return now - fs.statSync(path.join(library, SIGN_IN_MARKER)).mtimeMs < SIGN_IN_MAX_MS;
  } catch {
    return false;
  }
}

/* ─── The service ─────────────────────────────────────────────────────── */

/**
 * Runs until SIGTERM/SIGINT. Every 30 s it reads the engine's state and this
 * app's choices, then starts or stops the recorder and the action service
 * (capture.desiredChildren). Every 10 min, while recording, `sync test`
 * fetches fresh credentials: a revoked device or a project with Capture off
 * is refused and nothing runs until the person signs in again.
 */
async function runService({ library, engineDir, env = process.env, execPath = process.execPath, tickMs = TICK_MS, probeEveryMs = PROBE_EVERY_MS }) {
  const lock = path.join(library, 'service.lock');
  fs.mkdirSync(path.join(library, 'logs'), { recursive: true, mode: 0o700 });
  const holder = Number(readFileSafe(lock));
  if (holder && holder !== process.pid && isAlive(holder)) {
    console.log(`[capture-service] another service (pid ${holder}) runs this library; exiting`);
    return 0;
  }
  fs.writeFileSync(lock, String(process.pid));
  fs.writeFileSync(path.join(library, 'engine-config.yaml'), capture.engineConfigYaml(library));

  const paths = capture.enginePaths(engineDir);
  const engineEnv = capture.engineEnv({ library, paths, base: env });
  const spawnLogged = (name, file, args, childEnv = engineEnv) => {
    const fd = fs.openSync(path.join(library, 'logs', `${name}.log`), 'a', 0o600);
    try {
      // stdin is a pipe this service holds: the child ends when the service ends.
      return spawn(file, args, { env: childEnv, stdio: ['pipe', fd, fd], windowsHide: true });
    } finally {
      fs.closeSync(fd);
    }
  };

  let heartbeat = () => {};
  const recorder = capture.supervise({
    name: 'recorder',
    start: () => spawnLogged('recorder', paths.capture, ['record', '--supervised']),
    onChange: () => heartbeat(),
  });
  const actions = capture.supervise({
    name: 'actions',
    start: () =>
      spawnLogged('actions', execPath, ['-e', capture.GUARD, paths.backend, '--service'], { ...engineEnv, ELECTRON_RUN_AS_NODE: '1' }),
    onChange: () => heartbeat(),
  });

  const startedAt = new Date().toISOString();
  let lastProbe = null;
  let lastGranted = null;
  heartbeat = () => {
    try {
      writePrivateJson(library, 'service.json', {
        pid: process.pid,
        startedAt,
        updatedAt: new Date().toISOString(),
        engineDir,
        recorder: recorder.state(),
        actions: actions.state(),
        lastProbe,
      });
    } catch (error) {
      console.warn(`[capture-service] heartbeat: ${error}`);
    }
  };

  const json = (args) => capture.engineJson(paths.capture, args, { env: engineEnv }).catch(() => null);

  async function tick() {
    const desktop = capture.readDesktop(library);
    const [sync, permissions] = await Promise.all([
      json(['sync', 'status']),
      process.platform === 'darwin' ? json(['permissions']) : null,
    ]);
    const want = capture.desiredChildren({
      available: true,
      desktop,
      signedIn: sync?.kortix?.signed_in === true,
      signInRequired: sync?.kortix?.sign_in_required === true,
      policy: capture.policyOf(sync),
    });
    const pending = signInPending(library);
    // macOS applies a new grant only to a process started after it.
    const granted = capture.grantedPermissions(permissions);
    if (lastGranted && granted.some((key) => !lastGranted.includes(key))) {
      recorder.restart();
      actions.restart();
    }
    lastGranted = granted;
    if (want.recorder && !pending) recorder.run();
    else recorder.stop();
    if (want.actions && !pending) actions.run();
    else actions.stop();
    heartbeat();
  }

  async function probe() {
    if (!recorder.state().running) return;
    const result = await capture.runEngine(paths.capture, ['sync', 'test'], { env: engineEnv, timeoutMs: 60_000 });
    lastProbe = { at: new Date().toISOString(), ok: result.code === 0, ...(result.code ? { error: capture.lastError(result.stderr, `exit ${result.code}`) } : {}) };
    await tick();
  }

  let ticking = Promise.resolve();
  const schedule = (fn) => {
    ticking = ticking.then(fn).catch((error) => console.warn(`[capture-service] ${error}`));
    return ticking;
  };
  await schedule(tick);
  const tickTimer = setInterval(() => void schedule(tick), tickMs);
  const probeTimer = setInterval(() => void schedule(probe), probeEveryMs);
  console.log(`[capture-service] running for ${library} (engine ${engineDir})`);

  return new Promise((resolve) => {
    const shutdown = () => {
      clearInterval(tickTimer);
      clearInterval(probeTimer);
      recorder.stop();
      actions.stop();
      const done = () => {
        if (recorder.state().running || actions.state().running) return void setTimeout(done, 100);
        fs.rmSync(lock, { force: true });
        fs.rmSync(path.join(library, 'service.json'), { force: true });
        resolve(0);
      };
      done();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/* ─── Install and control ───────────────────────────────────────────── */

function control(verb, { library, engineDir, script, execPath = process.execPath, appImage = process.env.APPIMAGE, platform = process.platform, home = os.homedir() }) {
  const driver = supervisors.driverFor(platform);
  if (!driver) throw new Error(supervisors.UNSUPPORTED);
  const paths = servicePaths(library, home);
  const runner = runnerParts({ script, execPath, appImage, library, engineDir });
  const unit = driver.unitPath(paths);
  const installed = fs.existsSync(unit);
  if (verb === 'render') return driver.render(paths, runner);
  if (verb === 'install') {
    fs.mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
    if (platform === 'win32') fs.mkdirSync(path.dirname(paths.windowsScript), { recursive: true, mode: 0o700 });
  }
  const outcome =
    verb === 'install'
      ? driver.install(paths, runner)
      : verb === 'uninstall'
        ? driver.uninstall(paths)
        : verb === 'pause'
          ? driver.pause(paths, installed)
          : verb === 'resume'
            ? driver.resume(paths, installed)
            : verb === 'stop'
              ? driver.stop(paths, installed)
              : driver.status(paths, installed);
  const nowInstalled = fs.existsSync(unit);
  return {
    label: paths.label,
    path: unit,
    installed: outcome.installed ?? nowInstalled,
    active: outcome.active ?? null,
    ...(outcome.enabled !== undefined ? { enabled: outcome.enabled } : {}),
    // The unit on disk is exactly what install would write now (app moved or updated: false).
    upToDate: nowInstalled ? fs.readFileSync(unit, 'utf8') === driver.render(paths, runner) : false,
    heartbeat: readHeartbeat(library),
    ...(outcome.detail ? { detail: String(outcome.detail).slice(-2000) } : {}),
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const verb = argv[0];
  const library = env.KORTIX_CAPTURE_DIR;
  const engineDir = env.KORTIX_CAPTURE_ENGINE_DIR;
  if (!library || !engineDir) throw new Error('KORTIX_CAPTURE_DIR and KORTIX_CAPTURE_ENGINE_DIR are required');
  // KORTIX_CAPTURE_SERVICE_TICK_MS / _PROBE_MS: tests only (reconcile and probe intervals).
  if (verb === 'run') {
    return runService({
      library,
      engineDir,
      env,
      tickMs: Number(env.KORTIX_CAPTURE_SERVICE_TICK_MS) || TICK_MS,
      probeEveryMs: Number(env.KORTIX_CAPTURE_SERVICE_PROBE_MS) || PROBE_EVERY_MS,
    });
  }
  if (!['install', 'uninstall', 'pause', 'resume', 'stop', 'status', 'render'].includes(verb)) {
    throw new Error(`usage: capture-service.js run|install|uninstall|pause|resume|stop|status|render`);
  }
  const result = control(verb, { library, engineDir, script: path.resolve(process.argv[1]) });
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, argv.includes('--json') ? 0 : 2));
  return 0;
}

module.exports = { HEARTBEAT_STALE_MS, SIGN_IN_MARKER, control, main, readHeartbeat, runService, runnerParts, servicePaths, signInPending };

if (require.main === module) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    },
  );
}
