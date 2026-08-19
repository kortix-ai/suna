import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';

import {
  SUPPORTED_PLATFORMS_MESSAGE,
  type RunnerParts,
  posixShellCommand,
  serviceDriver,
} from './service-drivers';
import {
  type ServicePaths,
  getServicePaths,
  rotateServiceLogs,
} from './service-paths';

export {
  DEFAULT_INSTALL_BACKGROUND_SERVICE,
  MAX_SERVICE_LOG_BYTES,
  SERVICE_LABEL,
  TERMINAL_SERVICE_EXIT_CODE,
  type ServicePaths,
  getServicePaths,
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
    normalized.includes('/.yarn/$$virtual/')
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
  writeFileSync(
    join(paths.binDir, 'agent-cli.source.json'),
    JSON.stringify({ source, vendoredFrom: scriptPath }, null, 2),
    { mode: 0o600 },
  );
  return paths.vendoredRunner;
}

function currentRunnerParts(): RunnerParts {
  const script = process.argv[1];
  if (script && existsSync(script)) {
    return { command: process.execPath, args: [vendorRunner(script), 'run', '--service'] };
  }
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
  operate: (driver: NonNullable<ReturnType<typeof serviceDriver>>, paths: ServicePaths, installed: boolean) => {
    active?: boolean | null;
    installed?: boolean;
    detail?: string;
  },
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
    (driver, paths, installed) => driver.status(paths, installed),
    { installed: false, active: null },
  );
}
