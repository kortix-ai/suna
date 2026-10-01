import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';

import {
  SUPPORTED_PLATFORMS_MESSAGE,
  type Outcome,
  type RunnerParts,
  posixShellCommand,
  serviceDriver,
} from './service-drivers';
import {
  type ServicePaths,
  getServicePaths,
  rotateServiceLogs,
  serviceHomeEnv,
} from './service-paths';
import { agentTunnelVersion } from './version';

export {
  DEFAULT_INSTALL_BACKGROUND_SERVICE,
  MAX_SERVICE_LOG_BYTES,
  SERVICE_LABEL,
  TERMINAL_SERVICE_EXIT_CODE,
  type ServicePaths,
  agentTunnelHome,
  getServicePaths,
  serviceHomeEnv,
  serviceLabelFor,
  rotateServiceLogs,
  serviceLogFiles,
} from './service-paths';
export {
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsPowerShellScript,
} from './service-drivers';

export interface ServiceStatus {
  platform: NodeJS.Platform;
  installed: boolean;
  active: boolean | null;
  /** False while paused: disabled in the supervisor, so login does not start it. */
  enabled?: boolean;
  /**
   * The installed unit is exactly what `install` would write now. False after
   * an app update or move: the unit points at an old runner (R5).
   */
  upToDate?: boolean;
  path?: string;
  detail?: string;
}

/**
 * True for locations a package manager may delete without warning.
 *
 * `npx` extracts the package into a content-addressed cache directory and
 * garbage-collects it. A background service pointed at that path starts fine and
 * then dies permanently the first time the cache is pruned, leaving only a
 * MODULE_NOT_FOUND in a log file nobody reads.
 */
export function isEphemeralRunnerPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.includes('/_npx/') ||
    normalized.includes('/_cacache/') ||
    normalized.includes('/.pnpm-store/') ||
    normalized.includes('/.yarn/$$virtual/') ||
    // A Linux AppImage is mounted at a new /tmp/.mount_* path on every launch.
    normalized.includes('/.mount_')
  );
}

/**
 * Copies the running CLI bundle into ~/.agent-tunnel/bin so the installed
 * service owns its executable. The bundle is a single self-contained file that
 * imports only Node builtins, so a plain copy is sufficient.
 */
export function vendorRunner(scriptPath: string, paths: ServicePaths = getServicePaths()): string {
  if (!isEphemeralRunnerPath(scriptPath)) return scriptPath;

  mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  const source = realpathSync(scriptPath);
  copyFileSync(source, paths.vendoredRunner);
  try { chmodSync(paths.vendoredRunner, 0o700); } catch {}
  // The copy has no package.json beside it, so it would report version
  // "unknown" and the desktop's version check (R5) could never pass.
  writeFileSync(
    join(paths.binDir, 'package.json'),
    JSON.stringify({ name: '@kortix/agent-tunnel', version: agentTunnelVersion(), private: true }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(paths.binDir, 'agent-cli.source.json'),
    JSON.stringify({ source, vendoredFrom: scriptPath }, null, 2),
    { mode: 0o600 },
  );
  return paths.vendoredRunner;
}

/**
 * The command the supervisor runs: this interpreter and this bundle.
 *
 * Under Electron (the desktop app runs the bundle with ELECTRON_RUN_AS_NODE)
 * the interpreter is the app binary, which must be told to act as Node again,
 * and the bundle sits inside the app, which the updater replaces in place, so
 * it is not vendored. A Linux AppImage is the exception: its mount path changes
 * per launch, so the service runs the AppImage file and a vendored bundle.
 */
export function runnerPartsFor(
  script: string,
  runtime: { execPath: string; electron?: string; appImage?: string } = {
    execPath: process.execPath,
    electron: process.versions.electron,
    appImage: process.env.APPIMAGE,
  },
  paths: ServicePaths = getServicePaths(),
  vendor: (script: string, paths: ServicePaths) => string = vendorRunner,
): RunnerParts {
  const env = serviceHomeEnv(paths.configDir);
  if (runtime.electron) {
    return {
      command: runtime.appImage || runtime.execPath,
      args: [runtime.appImage ? vendor(script, paths) : script, 'run', '--service'],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: runtime.execPath, args: [vendor(script, paths), 'run', '--service'], env };
}

/** Where vendorRunner WOULD put the bundle, without copying anything. */
const plannedRunner = (script: string, paths: ServicePaths) =>
  isEphemeralRunnerPath(script) ? paths.vendoredRunner : script;

function currentRunnerParts(
  vendor: (script: string, paths: ServicePaths) => string = vendorRunner,
): RunnerParts {
  const script = process.argv[1];
  if (script && existsSync(script)) return runnerPartsFor(script, undefined, getServicePaths(), vendor);
  throw new Error(
    'Cannot install the background service because the current Agent Tunnel executable was not found',
  );
}

export function buildServiceShellCommand(): string {
  return posixShellCommand(currentRunnerParts());
}

/**
 * Runs one driver operation and normalises it into a ServiceStatus.
 *
 * Every public verb below shares this shape, which is why the per-platform
 * branching lives in the driver table rather than in six near-identical
 * functions.
 */
function withDriver(
  operate: (driver: NonNullable<ReturnType<typeof serviceDriver>>, paths: ServicePaths, installed: boolean) => Outcome,
  fallback: { installed: boolean; active: boolean | null },
): ServiceStatus {
  const driver = serviceDriver();
  const paths = getServicePaths();

  // Mutating verbs must fail loudly on an unsupported platform. Reporting a
  // successful-looking status would make the CLI claim it installed a service
  // that does not exist.
  if (!driver) throw new Error(SUPPORTED_PLATFORMS_MESSAGE);

  const path = driver.unitPath(paths);
  const installed = existsSync(path);
  const outcome = operate(driver, paths, installed);

  return {
    platform: platform(),
    installed: outcome.installed ?? installed,
    active: outcome.active ?? fallback.active,
    ...(outcome.enabled !== undefined ? { enabled: outcome.enabled } : {}),
    ...(outcome.upToDate !== undefined ? { upToDate: outcome.upToDate } : {}),
    path,
    detail: outcome.detail,
  };
}

export function installService(): ServiceStatus {
  const paths = getServicePaths();
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  rotateServiceLogs(paths);

  const runner = currentRunnerParts();
  return withDriver(
    (driver, servicePaths) => driver.install(servicePaths, runner),
    { installed: false, active: null },
  );
}

export function uninstallService(): ServiceStatus {
  // Remove the vendored executable too, so uninstall leaves no residue a later
  // install would silently reuse.
  rmSync(getServicePaths().binDir, { recursive: true, force: true });
  return withDriver(
    (driver, paths) => ({ ...driver.uninstall(paths), installed: false, active: false }),
    { installed: false, active: false },
  );
}

export function startService(): ServiceStatus {
  return withDriver(
    (driver, paths, installed) => driver.start(paths, installed),
    { installed: false, active: null },
  );
}

export function stopService(): ServiceStatus {
  return withDriver(
    (driver, paths, installed) => ({ ...driver.stop(paths, installed), active: false }),
    { installed: false, active: false },
  );
}

/** R3: stops the service and keeps it stopped across login and reboot. */
export function pauseService(): ServiceStatus {
  return withDriver(
    (driver, paths, installed) => ({ ...driver.pause(paths, installed), active: false }),
    { installed: false, active: false },
  );
}

/**
 * Reverses pauseService. A unit that points at an old runner (the app moved or
 * updated while paused) is rewritten first, so Resume never starts a unit whose
 * executable is gone.
 */
export function resumeService(): ServiceStatus {
  const current = getServiceStatus();
  // Install enables the job on every supervisor, so it also ends the pause.
  if (current.installed && current.upToDate === false) return installService();
  return resumeUnit();
}

function resumeUnit(): ServiceStatus {
  return withDriver(
    (driver, paths, installed) => driver.resume(paths, installed),
    { installed: false, active: null },
  );
}

export function restartService(): ServiceStatus {
  stopService();
  return startService();
}

export function getServiceStatus(): ServiceStatus {
  // Status is the one verb that must answer on every platform: callers use it
  // to decide whether a service exists at all.
  if (!serviceDriver()) {
    return {
      platform: platform(),
      installed: false,
      active: null,
      detail: SUPPORTED_PLATFORMS_MESSAGE,
    };
  }
  return withDriver(
    (driver, paths, installed) => {
      let upToDate = false;
      try {
        upToDate = installed && readFileSync(driver.unitPath(paths), 'utf8') === driver.render(paths, currentRunnerParts(plannedRunner));
      } catch {}
      return { ...driver.status(paths, installed), upToDate };
    },
    { installed: false, active: null },
  );
}
