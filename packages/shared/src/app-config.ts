/**
 * The configuration of one App release: process groups,
 * services (named ports), mounts (volumes), VM sizes, checks and the deploy
 * strategy. `kortix.yaml` `apps.<name>` is the authored form; the
 * CLI resolves it with `resolveAppReleaseConfig`, the API validates it again
 * with `appReleaseConfigIssues` and stores the result on the release, and the
 * deploy engine reads only the resolved form.
 *
 * Pure and dependency-free: the API, the CLI, the SDK and the manifest schema
 * share it.
 */

export type AppDeployStrategy = 'rolling' | 'immediate' | 'bluegreen' | 'canary';
export type AppAutoStop = 'off' | 'stop' | 'suspend';
/** `public`: no gate. `app`: the App's access policy and Kortix sign-in. `admins`: project admins only. */
export type AppServiceAccess = 'public' | 'app' | 'admins';
export type AppServiceProtocol = 'http' | 'tcp';

export interface AppCheck {
  type: 'http' | 'tcp';
  /** Defaults to the service's `internal_port`. */
  port?: number;
  /** http only. */
  path?: string;
  interval_s: number;
  timeout_s: number;
  grace_period_s: number;
}

export interface AppService {
  /** `http` is the primary service: it answers on the App's own host. */
  name: string;
  internal_port: number;
  protocol: AppServiceProtocol;
  access: AppServiceAccess;
  auto_stop_machines: AppAutoStop;
  auto_start_machines: boolean;
  min_machines_running: number;
  /** Process groups that serve this port. */
  processes: string[];
  checks: AppCheck[];
}

export interface AppMount {
  /** Volume name. Each machine of the group gets its own volume of this name. */
  source: string;
  destination: string;
  initial_size_gb: number;
  snapshot_retention_days: number;
  processes: string[];
}

export interface AppVmSize {
  cpu: number;
  memory_gb: number;
  /** Root disk; the data belongs on a mount. */
  disk_gb: number;
  /** Groups this size applies to; empty = every group without a more specific entry. */
  processes: string[];
}

export interface AppDeployConfig {
  strategy: AppDeployStrategy;
  /** Runs once per release in a temporary machine (new image, secrets, no mounts) before machines update. */
  release_command: string | null;
}

export interface AppReleaseConfig {
  /** Group name → command. `""` runs the image's own command. */
  processes: Record<string, string>;
  services: AppService[];
  mounts: AppMount[];
  vm: AppVmSize[];
  deploy: AppDeployConfig;
}

/** The authored form: every field optional, plus the shorthands Apps had before this model. */
export interface AppReleaseConfigInput {
  processes?: Record<string, string>;
  http_service?: Partial<Omit<AppService, 'name' | 'checks'>> & { checks?: Array<Partial<AppCheck>> };
  services?: Array<Partial<Omit<AppService, 'checks'>> & { checks?: Array<Partial<AppCheck>> }>;
  mounts?: Array<Partial<AppMount>>;
  vm?: Partial<AppVmSize> | Array<Partial<AppVmSize>>;
  deploy?: Partial<AppDeployConfig>;
  /** Shorthands. */
  port?: number;
  command?: string;
  readiness_path?: string;
  always_on?: boolean;
  resources?: { cpu?: number; memory_gb?: number; disk_gb?: number };
}

export interface AppConfigIssue {
  path: string;
  message: string;
}

export const DEFAULT_PROCESS_GROUP = 'app';
export const PRIMARY_SERVICE = 'http';
/** Ports the App supervisor owns inside every machine. */
export const RESERVED_APP_PORTS = [7331, 8080] as const;
export const APP_VM_LIMITS = { cpu: { min: 1, max: 32 }, memory_gb: { min: 1, max: 128 }, disk_gb: { min: 1, max: 500 } } as const;
export const DEFAULT_APP_VM = { cpu: 1, memory_gb: 2, disk_gb: 10 } as const;
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 5;
export const MAX_SNAPSHOT_RETENTION_DAYS = 60;
/** Platinum caps a volume at 100 GiB (its largest size class). */
export const MAX_VOLUME_GB = 100;

const GROUP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
/** Volume names: letters, digits and underscores. */
const VOLUME_NAME = /^[a-z0-9_]{1,30}$/;
const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/kortix'];

function check(input: Partial<AppCheck> | undefined, fallbackPath?: string): AppCheck {
  const type = input?.type ?? (input?.path ?? fallbackPath ? 'http' : 'tcp');
  return {
    type,
    ...(input?.port !== undefined ? { port: input.port } : {}),
    ...(type === 'http' ? { path: input?.path ?? fallbackPath ?? '/' } : {}),
    interval_s: input?.interval_s ?? 15,
    timeout_s: input?.timeout_s ?? 5,
    grace_period_s: input?.grace_period_s ?? 10,
  };
}

/**
 * The resolved release config. Shorthands map onto the full fields:
 * `port` → `http_service.internal_port`, `command` → `processes.app`,
 * `readiness_path` → an http check, `always_on` → `auto_stop_machines: off` and
 * `min_machines_running: 1` (`false`: `stop` and 0), `resources` → the default VM.
 * An explicit full field wins over its shorthand.
 */
export function resolveAppReleaseConfig(input: AppReleaseConfigInput = {}): AppReleaseConfig {
  const processes = input.processes && Object.keys(input.processes).length > 0
    ? { ...input.processes }
    : { [DEFAULT_PROCESS_GROUP]: input.command ?? '' };
  const allGroups = Object.keys(processes);
  const alwaysOn = input.always_on ?? true;
  const http = input.http_service;
  const primaryPort = http?.internal_port ?? input.port;
  const services: AppService[] = [];
  if (primaryPort !== undefined) {
    services.push({
      name: PRIMARY_SERVICE,
      internal_port: primaryPort,
      protocol: http?.protocol ?? 'http',
      access: http?.access ?? 'app',
      auto_stop_machines: http?.auto_stop_machines ?? (alwaysOn ? 'off' : 'stop'),
      auto_start_machines: http?.auto_start_machines ?? true,
      min_machines_running: http?.min_machines_running ?? (alwaysOn ? 1 : 0),
      processes: http?.processes?.length ? [...http.processes] : [allGroups[0]!],
      checks: http?.checks?.length
        ? http.checks.map((entry) => check(entry))
        : input.readiness_path ? [check(undefined, input.readiness_path)] : [],
    });
  }
  for (const service of input.services ?? []) {
    services.push({
      name: service.name ?? '',
      internal_port: service.internal_port ?? 0,
      protocol: service.protocol ?? 'http',
      access: service.access ?? 'app',
      auto_stop_machines: service.auto_stop_machines ?? (alwaysOn ? 'off' : 'stop'),
      auto_start_machines: service.auto_start_machines ?? true,
      min_machines_running: service.min_machines_running ?? 0,
      processes: service.processes?.length ? [...service.processes] : [allGroups[0]!],
      checks: (service.checks ?? []).map((entry) => check(entry)),
    });
  }
  const mounts: AppMount[] = (input.mounts ?? []).map((mount) => ({
    source: mount.source ?? '',
    destination: mount.destination ?? '',
    initial_size_gb: mount.initial_size_gb ?? 1,
    snapshot_retention_days: mount.snapshot_retention_days ?? DEFAULT_SNAPSHOT_RETENTION_DAYS,
    processes: mount.processes?.length ? [...mount.processes] : [...allGroups],
  }));
  const vmInputs = Array.isArray(input.vm) ? input.vm : input.vm ? [input.vm] : [];
  const vm: AppVmSize[] = vmInputs.length > 0
    ? vmInputs.map((size) => ({
        cpu: size.cpu ?? input.resources?.cpu ?? DEFAULT_APP_VM.cpu,
        memory_gb: size.memory_gb ?? input.resources?.memory_gb ?? DEFAULT_APP_VM.memory_gb,
        disk_gb: size.disk_gb ?? input.resources?.disk_gb ?? DEFAULT_APP_VM.disk_gb,
        processes: size.processes ? [...size.processes] : [],
      }))
    : [{
        cpu: input.resources?.cpu ?? DEFAULT_APP_VM.cpu,
        memory_gb: input.resources?.memory_gb ?? DEFAULT_APP_VM.memory_gb,
        disk_gb: input.resources?.disk_gb ?? DEFAULT_APP_VM.disk_gb,
        processes: [],
      }];
  return {
    processes,
    services,
    mounts,
    vm,
    deploy: {
      // Bluegreen and canary need two machines on one volume, so a volume refuses them; without them a full swap keeps the App up.
      strategy: input.deploy?.strategy ?? (mounts.length > 0 ? 'rolling' : 'bluegreen'),
      release_command: input.deploy?.release_command?.trim() ? input.deploy.release_command.trim() : null,
    },
  };
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Every rule the deploy engine relies on. Empty = valid. */
export function appReleaseConfigIssues(config: AppReleaseConfig): AppConfigIssue[] {
  const issues: AppConfigIssue[] = [];
  const groups = Object.keys(config.processes);
  if (groups.length === 0) issues.push({ path: 'processes', message: 'needs at least one process group.' });
  for (const group of groups) {
    if (!GROUP_NAME.test(group)) issues.push({ path: `processes.${group}`, message: 'a group name is lowercase letters, digits, "-" or "_", starting with a letter.' });
  }
  const knownGroups = (path: string, list: string[]) => {
    for (const group of list) if (!groups.includes(group)) issues.push({ path, message: `names the unknown process group "${group}".` });
  };

  const names = new Set<string>();
  const ports = new Set<number>();
  // `services[n]` counts the authored `services` list, which excludes the primary.
  const offset = config.services[0]?.name === PRIMARY_SERVICE ? 1 : 0;
  config.services.forEach((service, index) => {
    const path = service.name === PRIMARY_SERVICE && index === 0 ? 'http_service' : `services[${index - offset}]`;
    if (!SERVICE_NAME.test(service.name)) issues.push({ path: `${path}.name`, message: 'a service name is lowercase letters, digits and "-", starting with a letter.' });
    if (service.name === PRIMARY_SERVICE && index !== 0) issues.push({ path: `${path}.name`, message: '"http" is the primary service: declare it as http_service.' });
    if (names.has(service.name)) issues.push({ path: `${path}.name`, message: `"${service.name}" is declared twice.` });
    names.add(service.name);
    if (service.protocol !== 'http') issues.push({ path: `${path}.protocol`, message: 'only http services are served today; tcp is not supported yet.' });
    if (!inRange(service.internal_port, 1, 65535)) issues.push({ path: `${path}.internal_port`, message: 'must be a port from 1 to 65535.' });
    if ((RESERVED_APP_PORTS as readonly number[]).includes(service.internal_port)) {
      issues.push({ path: `${path}.internal_port`, message: `${service.internal_port} is reserved by the App supervisor.` });
    }
    if (ports.has(service.internal_port)) issues.push({ path: `${path}.internal_port`, message: `port ${service.internal_port} is used by another service.` });
    ports.add(service.internal_port);
    if (!inRange(service.min_machines_running, 0, 100)) issues.push({ path: `${path}.min_machines_running`, message: 'must be 0 to 100.' });
    knownGroups(`${path}.processes`, service.processes);
    service.checks.forEach((entry, checkIndex) => {
      const at = `${path}.checks[${checkIndex}]`;
      if (entry.type === 'http' && !entry.path?.startsWith('/')) issues.push({ path: `${at}.path`, message: 'must start with "/".' });
      if (entry.port !== undefined && !inRange(entry.port, 1, 65535)) issues.push({ path: `${at}.port`, message: 'must be a port from 1 to 65535.' });
      if (!inRange(entry.interval_s, 1, 3600) || !inRange(entry.timeout_s, 1, 600) || !inRange(entry.grace_period_s, 0, 3600)) {
        issues.push({ path: at, message: 'interval_s is 1-3600, timeout_s 1-600, grace_period_s 0-3600 (whole seconds).' });
      }
    });
  });

  const mountedGroups = new Set<string>();
  const sources = new Set<string>();
  config.mounts.forEach((mount, index) => {
    const path = `mounts[${index}]`;
    if (!VOLUME_NAME.test(mount.source)) issues.push({ path: `${path}.source`, message: 'a volume name is 1-30 lowercase letters, digits or "_".' });
    if (sources.has(mount.source)) issues.push({ path: `${path}.source`, message: `volume "${mount.source}" is mounted twice.` });
    sources.add(mount.source);
    const destination = mount.destination;
    if (!destination.startsWith('/') || destination === '/' || destination.endsWith('/')) {
      issues.push({ path: `${path}.destination`, message: 'must be an absolute path other than "/", without a trailing "/".' });
    } else if (SYSTEM_DIRS.some((dir) => destination === dir || destination.startsWith(`${dir}/`))) {
      issues.push({ path: `${path}.destination`, message: 'cannot sit under a system directory.' });
    }
    if (!inRange(mount.initial_size_gb, 1, MAX_VOLUME_GB)) issues.push({ path: `${path}.initial_size_gb`, message: `must be 1 to ${MAX_VOLUME_GB}.` });
    if (!inRange(mount.snapshot_retention_days, 1, MAX_SNAPSHOT_RETENTION_DAYS)) {
      issues.push({ path: `${path}.snapshot_retention_days`, message: `must be 1 to ${MAX_SNAPSHOT_RETENTION_DAYS}.` });
    }
    knownGroups(`${path}.processes`, mount.processes);
    for (const group of mount.processes) {
      // A machine mounts at most one volume.
      if (mountedGroups.has(group)) issues.push({ path: `${path}.processes`, message: `process group "${group}" already mounts a volume; a machine mounts one.` });
      mountedGroups.add(group);
    }
  });

  config.vm.forEach((size, index) => {
    const path = `vm[${index}]`;
    if (!inRange(size.cpu, APP_VM_LIMITS.cpu.min, APP_VM_LIMITS.cpu.max)) issues.push({ path: `${path}.cpu`, message: `must be ${APP_VM_LIMITS.cpu.min} to ${APP_VM_LIMITS.cpu.max}.` });
    if (!inRange(size.memory_gb, APP_VM_LIMITS.memory_gb.min, APP_VM_LIMITS.memory_gb.max)) issues.push({ path: `${path}.memory_gb`, message: `must be ${APP_VM_LIMITS.memory_gb.min} to ${APP_VM_LIMITS.memory_gb.max}.` });
    if (!inRange(size.disk_gb, APP_VM_LIMITS.disk_gb.min, APP_VM_LIMITS.disk_gb.max)) issues.push({ path: `${path}.disk_gb`, message: `must be ${APP_VM_LIMITS.disk_gb.min} to ${APP_VM_LIMITS.disk_gb.max}.` });
    knownGroups(`${path}.processes`, size.processes);
  });

  if (mountedGroups.size > 0 && (config.deploy.strategy === 'bluegreen' || config.deploy.strategy === 'canary')) {
    issues.push({ path: 'deploy.strategy', message: `${config.deploy.strategy} needs two machines on one volume; an App with mounts deploys rolling or immediate.` });
  }
  if (config.deploy.release_command !== null && config.deploy.release_command.length > 2000) {
    issues.push({ path: 'deploy.release_command', message: 'is at most 2000 characters.' });
  }
  return issues;
}

/** The VM size of one process group: its own entry, else the default entry, else the platform default. */
export function appVmFor(config: AppReleaseConfig, group: string): Omit<AppVmSize, 'processes'> {
  const own = config.vm.find((size) => size.processes.includes(group));
  const fallback = config.vm.find((size) => size.processes.length === 0);
  const size = own ?? fallback ?? { ...DEFAULT_APP_VM, processes: [] };
  return { cpu: size.cpu, memory_gb: size.memory_gb, disk_gb: size.disk_gb };
}

/** The mount a machine of this group gets, or null. */
export function appMountFor(config: AppReleaseConfig, group: string): AppMount | null {
  return config.mounts.find((mount) => mount.processes.includes(group)) ?? null;
}

/** The services a machine of this group serves. */
export function appServicesFor(config: AppReleaseConfig, group: string): AppService[] {
  return config.services.filter((service) => service.processes.includes(group));
}

/**
 * Where Kortix shows an App (`kortix.yaml` `apps.<name>.display`). Presentation
 * only: nothing about how the App runs or who may open it changes.
 */
export interface AppDisplay {
  /** A card in the Apps grid. Default true; an App with a `parent` has none. */
  listed?: boolean;
  /** The card thumbnail: `live` frames the App, `none` shows an icon. Default `live`. */
  preview?: 'live' | 'none';
  /** The App, by slug, whose detail shows this one as a tab (a backend's admin dashboard). */
  parent?: string;
}

/** What the Apps grid reads of an App: the web's `App` and the API's App JSON both fit. */
export interface GridApp {
  slug: string;
  display?: AppDisplay | null;
  services?: ReadonlyArray<{ name: string; access?: string | null }> | null;
}

/**
 * Its primary service is `access: admins` (a backend's admin dashboard): only
 * project admins can open it, so nobody else is shown a card or tab for it.
 */
export function appAdminsOnly(app: GridApp): boolean {
  return app.services?.find((service) => service.name === 'http')?.access === 'admins';
}

/**
 * The Apps the grid shows as cards (`display`): not `listed: false`, not a tab
 * of a parent in the same list, and not admins-only for a non-admin. A tab
 * whose parent is gone stays reachable as a card. The Apps page, a channel's
 * Apps tab and the channel's Apps count all apply this one rule.
 */
export function gridApps<T extends GridApp>(apps: readonly T[], canAdmin = true): T[] {
  const slugs = new Set(apps.map((app) => app.slug));
  return apps.filter(
    (app) =>
      app.display?.listed !== false &&
      !(app.display?.parent && slugs.has(app.display.parent)) &&
      (canAdmin || !appAdminsOnly(app)),
  );
}

const DISPLAY_KEYS = new Set(['listed', 'preview', 'parent']);
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What is wrong with an authored `display` block of the App `slug`. Paths are relative to the block. */
export function appDisplayIssues(display: unknown, slug: string): AppConfigIssue[] {
  if (typeof display !== 'object' || display === null || Array.isArray(display)) return [{ path: '', message: 'must be an object.' }];
  const issues: AppConfigIssue[] = [];
  const value = display as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!DISPLAY_KEYS.has(key)) issues.push({ path: key, message: 'is not a display field (listed, preview, parent).' });
  }
  if (value.listed !== undefined && typeof value.listed !== 'boolean') issues.push({ path: 'listed', message: 'must be true or false.' });
  if (value.preview !== undefined && value.preview !== 'live' && value.preview !== 'none') issues.push({ path: 'preview', message: 'must be live or none.' });
  if (value.parent !== undefined) {
    if (typeof value.parent !== 'string' || !APP_SLUG.test(value.parent)) issues.push({ path: 'parent', message: 'must be an App slug.' });
    else if (value.parent === slug) issues.push({ path: 'parent', message: 'an App cannot be its own parent.' });
  }
  return issues;
}
