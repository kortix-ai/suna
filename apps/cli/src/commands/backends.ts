import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectBackend, ProjectBackendCredentials, ProjectBackendSize, ProjectHandle } from '@kortix/sdk';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import { openInBrowser } from '../browser.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { projectWebUrl } from '../web-url.ts';

const HELP = help`Usage: kortix backends <subcommand> [options]

Self-hosted Convex backends. Each backend runs in its own machine. A project
owns up to 3. <name|id> is the backend name or its id.

Subcommands:
  list | ls                         List backends. --json.
  create <name>                     Create and boot a backend. Takes seconds, or
                                    minutes on the first image build. --json.
    --cpu <1-16>                    vCPUs. Default 1.
    --memory <1-32>                 Memory in GB. Default 2.
    --disk <10-100>                 Disk in GB. Default 10.
  resize <name|id>                  Change the machine size. Give at least one of
                                    --cpu, --memory, --disk. A disk never shrinks.
                                    Waits until the resize ends, then prints the
                                    new size. --json.
    --no-wait                       Return as soon as the resize starts.
  backups <name|id>                 Show the automatic backup and the snapshots,
                                    newest first. --json.
  snapshot <name|id>                Take a snapshot now. The backend keeps the
                                    newest 5. --json.
  restore <name|id> <snapshot-id>   Roll the backend back to a snapshot. Every
                                    change after it is lost. --json.
    --yes                           Skip the confirmation.
  get <name|id>                     Show one backend. --json.
  dashboard <name|id>               Print the backend's admin dashboard link:
                                    Convex's dashboard (data, functions, logs,
                                    files, schedules, env) inside Kortix,
                                    signed in for you. --json.
    --open                          Also open it in the browser.
  env <name|id>                     Print the Convex CLI credentials.
    --format shell|dotenv|json      shell (default): export lines for
                                    eval "$(kortix backends env main)".
                                    dotenv: KEY=value lines for .env.local.
                                    json: the full credentials object.
  token <name|id>                   Print a one-hour Kortix sign-in token naming
                                    you. Convex functions read you with
                                    ctx.auth.getUserIdentity(). --json adds
                                    expires_at.
  deploy <name> [-- <convex args>]  Deploy ./convex to the backend with
                                    npx convex deploy. Creates the backend when
                                    it does not exist.
    --dir <path>                    Directory with convex/ or convex.json.
                                    Default: the current directory.
  delete <name|id>                  Delete the backend and its machine.
    --yes                           Skip the confirmation.

Global options:
  --project <id>     Operate on this project id.
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.
`;

type BackendsHandle = ProjectHandle['backends'];
type ContextOptions = { projectArg?: string; hostArg?: string };
type Ctx = NonNullable<Awaited<ReturnType<typeof context>>>;

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const ENV_FORMATS = ['shell', 'dotenv', 'json'] as const;
type EnvFormat = (typeof ENV_FORMATS)[number];

async function context(options: ContextOptions): Promise<{
  auth: NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>['auth'];
  backends: BackendsHandle;
  projectUrl: string;
} | null> {
  const resolved = await resolveProjectContext(options);
  if (!resolved) return null;
  const kortix = kortixFromAuth(resolved.auth);
  const project = await withKortixScope(resolved.auth, () =>
    kortix.project(resolved.projectId).get(),
  );
  if (project.experimental?.backends !== true) {
    process.stderr.write(
      `${status.err('Backends is not enabled for this project. Contact Kortix to enable it.')}\n`,
    );
    return null;
  }
  return {
    auth: resolved.auth,
    backends: kortix.project(resolved.projectId).backends,
    projectUrl: projectWebUrl(resolved.auth.api_base, resolved.projectId, project.dashboard_url),
  };
}

const scoped = <T>(ctx: Ctx, fn: () => Promise<T>) => withKortixScope(ctx.auth, fn);

/** The backend a user named: its name, or its id (a UUID). */
export function findBackend(rows: ProjectBackend[], target: string): ProjectBackend | undefined {
  return rows.find((row) => row.name === target || row.backend_id === target);
}

async function resolveBackend(backends: BackendsHandle, target: string): Promise<ProjectBackend> {
  const found = findBackend(await backends.list(), target);
  if (!found) throw new Error(`Backend ${target} not found`);
  return found;
}

/** POSIX single-quote escaping: `'` becomes `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Single quotes keep a dotenv value literal. A value with `'` falls back to a JSON string. */
function dotenvQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
}

export function renderEnv(credentials: ProjectBackendCredentials, format: EnvFormat): string {
  if (format === 'json') return `${JSON.stringify(credentials, null, 2)}\n`;
  const quote = format === 'shell' ? shellQuote : dotenvQuote;
  return Object.entries(credentials.env)
    .map(([key, value]) => (format === 'shell' ? `export ${key}=${quote(value)}` : `${key}=${quote(value)}`))
    .join('\n')
    .concat('\n');
}

function takeCommon(rest: string[]) {
  const json = takeFlagBool(rest, ['--json']);
  return {
    json,
    options: {
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
    } satisfies ContextOptions,
  };
}

export async function runBackends(argv: string[]): Promise<number> {
  // Everything after `--` belongs to `convex deploy`; flags there must not be taken.
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const extra = separator === -1 ? [] : argv.slice(separator + 1);
  const helpCode = splitHelp(own, HELP);
  if (helpCode !== null) return helpCode;
  const subcommand = own[0];
  const rest = own.slice(1);
  try {
    const common = takeCommon(rest);
    switch (subcommand) {
      case 'list':
      case 'ls':
        return await listCommand(common.options, common.json);
      case 'create':
      case 'new':
        return await createCommand(rest, common.options, common.json);
      case 'resize':
        return await resizeCommand(rest, common.options, common.json);
      case 'backups':
        return await backupsCommand(rest, common.options, common.json);
      case 'snapshot':
        return await snapshotCommand(rest, common.options, common.json);
      case 'restore':
        return await restoreCommand(rest, common.options, common.json);
      case 'get':
      case 'show':
        return await getCommand(rest, common.options, common.json);
      case 'dashboard':
      case 'open':
        return await dashboardCommand(rest, common.options, common.json);
      case 'env':
        return await envCommand(rest, common.options);
      case 'token':
        return await tokenCommand(rest, common.options, common.json);
      case 'deploy':
        return await deployCommand(rest, extra, common.options);
      case 'delete':
      case 'rm':
      case 'remove':
        return await deleteCommand(rest, common.options, common.json);
      default:
        return fail(`unknown backends subcommand "${subcommand}"`);
    }
  } catch (error) {
    return surfaceApiError(error);
  }
}

function backendLines(backend: ProjectBackend): string {
  const row = (label: string, value: string | null) =>
    `  ${C.dim}${pad(label, 10)}${C.reset}${value ?? '-'}\n`;
  return (
    row('status', backend.status) +
    row('url', backend.url) +
    row('site url', backend.site_url) +
    row('dashboard', backend.dashboard_url ? 'kortix backends dashboard ' + backend.name : null) +
    row('machine', `${backend.cpu} vCPU · ${backend.memory_gb} GB · ${backend.disk_gb} GB disk`) +
    (backend.error ? row('error', backend.error) : '')
  );
}

async function listCommand(options: ContextOptions, json: boolean): Promise<number> {
  const ctx = await context(options);
  if (!ctx) return 1;
  const backends = await scoped(ctx, () => ctx.backends.list());
  if (json) {
    emitJson({ backends });
    return 0;
  }
  if (backends.length === 0) {
    process.stdout.write(`\n  ${C.dim}No backends. Create one with kortix backends create <name>.${C.reset}\n\n`);
    return 0;
  }
  const width = Math.max(4, ...backends.map((backend) => backend.name.length));
  process.stdout.write(`\n  ${C.bold}${pad('NAME', width)}  STATUS        URL${C.reset}\n`);
  for (const backend of backends) {
    process.stdout.write(
      `  ${pad(backend.name, width)}  ${pad(backend.status, 12)}  ${backend.url ?? '-'}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

function validName(name: string): string | null {
  return NAME_PATTERN.test(name)
    ? null
    : `backend name "${name}" must be lowercase letters, digits and dashes, starting with a letter (max 63)`;
}

const SIZE_FLAGS = [
  { key: 'cpu', flag: '--cpu', min: 1, max: 16 },
  { key: 'memory_gb', flag: '--memory', min: 1, max: 32 },
  { key: 'disk_gb', flag: '--disk', min: 10, max: 100 },
] as const;

/** Takes `--cpu`, `--memory` and `--disk` off `rest`. Returns the size, or the message to fail with. */
function takeSize(rest: string[]): { size: ProjectBackendSize } | { error: string } {
  const size: ProjectBackendSize = {};
  for (const { key, flag, min, max } of SIZE_FLAGS) {
    const raw = takeFlagValue(rest, [flag]);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: `${flag} must be a whole number from ${min} to ${max}` };
    }
    size[key] = value;
  }
  return { size };
}

async function createBackend(
  ctx: Ctx,
  name: string,
  quiet: boolean,
  size: ProjectBackendSize = {},
): Promise<ProjectBackend> {
  if (!quiet) {
    process.stderr.write(
      `${C.dim}Creating backend ${name}. This takes seconds, or minutes on the first image build.${C.reset}\n`,
    );
  }
  return scoped(ctx, async () => {
    const created = await ctx.backends.create({ name, ...size });
    return ctx.backends.waitUntilRunning(created.backend_id);
  });
}

async function createCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const sized = takeSize(rest);
  if ('error' in sized) return fail(sized.error);
  const name = rest.find((value) => !value.startsWith('-'));
  if (!name) return fail('create needs a backend name');
  const invalid = validName(name);
  if (invalid) return fail(invalid);
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await createBackend(ctx, name, json, sized.size);
  if (json) emitJson({ backend });
  else process.stdout.write(`\n  ${status.ok(`created ${backend.name}`)}\n${backendLines(backend)}\n`);
  return 0;
}

async function getCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('get needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await scoped(ctx, () => resolveBackend(ctx.backends, target));
  if (json) emitJson({ backend });
  else process.stdout.write(`\n  ${C.bold}${backend.name}${C.reset}\n${backendLines(backend)}\n`);
  return 0;
}

/** The Kortix web page that frames the backend's Convex dashboard. */
export function backendDashboardPage(projectUrl: string, backendId: string): string {
  return `${projectUrl}/backends/${backendId}`;
}

async function dashboardCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const open = takeFlagBool(rest, ['--open']);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('dashboard needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await scoped(ctx, () => resolveBackend(ctx.backends, target));
  const url = backendDashboardPage(ctx.projectUrl, backend.backend_id);
  if (json) {
    emitJson({ url, dashboard_available: backend.dashboard_url !== null, backend });
    return 0;
  }
  process.stdout.write(`${url}\n`);
  if (!backend.dashboard_url) {
    process.stderr.write(
      `${status.warn(
        backend.status === 'running'
          ? 'This backend was created before the dashboard shipped. Create a new backend to get it.'
          : `The dashboard opens when the backend is running (now: ${backend.status}).`,
      )}\n`,
    );
  }
  if (open) openInBrowser(url);
  return 0;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

const formatTime = (iso: string | null): string =>
  iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never';

async function resizeCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const wait = !takeFlagBool(rest, ['--no-wait']);
  const sized = takeSize(rest);
  if ('error' in sized) return fail(sized.error);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('resize needs a backend name or id');
  if (Object.keys(sized.size).length === 0) return fail('resize needs at least one of --cpu, --memory, --disk');
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await scoped(ctx, async () => {
    const found = await resolveBackend(ctx.backends, target);
    const started = await ctx.backends.resize(found.backend_id, sized.size);
    if (!wait) return started;
    if (!json) {
      process.stderr.write(`${C.dim}Resizing ${found.name}. The backend restarts on the new size.${C.reset}\n`);
    }
    return ctx.backends.waitForOperation(found.backend_id);
  });
  if (json) emitJson({ backend });
  else if (backend.operation) {
    process.stdout.write(`\n  ${status.ok(`resizing ${backend.name}`)}\n\n`);
  } else {
    process.stdout.write(
      `\n  ${status.ok(`resized ${backend.name}`)}\n${backendLines(backend)}\n`,
    );
  }
  return 0;
}

async function backupsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('backups needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const backups = await scoped(ctx, async () =>
    ctx.backends.backups((await resolveBackend(ctx.backends, target)).backend_id),
  );
  if (json) {
    emitJson(backups);
    return 0;
  }
  const { automatic, snapshots } = backups;
  const every = automatic.interval_minutes ? ` · every ${automatic.interval_minutes} min` : '';
  process.stdout.write(
    `\n  ${C.bold}automatic${C.reset}  last ${formatTime(automatic.last_backup_at)} · ${formatBytes(automatic.size_bytes)}${every}\n`,
  );
  if (snapshots.length === 0) {
    process.stdout.write(`\n  ${C.dim}No snapshots. Take one with kortix backends snapshot ${target}.${C.reset}\n\n`);
    return 0;
  }
  const width = Math.max(11, ...snapshots.map((row) => row.snapshot_id.length));
  process.stdout.write(`\n  ${C.bold}${pad('SNAPSHOT', width)}  ${pad('CREATED', 20)}  SIZE${C.reset}\n`);
  for (const row of snapshots) {
    process.stdout.write(
      `  ${pad(row.snapshot_id, width)}  ${pad(formatTime(row.created_at), 20)}  ${formatBytes(row.size_bytes)}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

async function snapshotCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('snapshot needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const snapshot = await scoped(ctx, async () =>
    ctx.backends.snapshot((await resolveBackend(ctx.backends, target)).backend_id),
  );
  if (json) emitJson(snapshot);
  else process.stdout.write(`\n  ${status.ok(`snapshot ${snapshot.snapshot_id} taken`)}\n\n`);
  return 0;
}

async function restoreCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const [target, snapshotId] = rest.filter((value) => !value.startsWith('-'));
  if (!target || !snapshotId) return fail('restore needs a backend name or id and a snapshot id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await scoped(ctx, () => resolveBackend(ctx.backends, target));
  if (!yes) {
    const ok = await confirm(
      `Restore backend ${C.bold}${backend.name}${C.reset} to snapshot ${snapshotId}? Every change after the snapshot is lost.`,
      false,
      { onEndOfInput: false },
    );
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }
  const restored = await scoped(ctx, () => ctx.backends.restore(backend.backend_id, snapshotId));
  if (json) emitJson({ backend: restored });
  else process.stdout.write(`\n  ${status.ok(`restored ${restored.name} to ${snapshotId}`)}\n\n`);
  return 0;
}

async function tokenCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('token needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const minted = await scoped(ctx, async () => ctx.backends.token((await resolveBackend(ctx.backends, target)).backend_id));
  if (json) emitJson(minted);
  else process.stdout.write(`${minted.token}\n`);
  return 0;
}

async function envCommand(rest: string[], options: ContextOptions): Promise<number> {
  const format = (takeFlagValue(rest, ['--format']) ?? 'shell') as EnvFormat;
  if (!ENV_FORMATS.includes(format)) return fail(`--format must be one of ${ENV_FORMATS.join(', ')}`);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('env needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const credentials = await scoped(ctx, async () => {
    const backend = await resolveBackend(ctx.backends, target);
    return ctx.backends.credentials(backend.backend_id);
  });
  process.stdout.write(renderEnv(credentials, format));
  return 0;
}

/** `npx convex deploy` against the backend. The child env drops every variable that selects another deployment. */
export function convexDeployEnv(
  base: NodeJS.ProcessEnv,
  credentials: ProjectBackendCredentials,
): NodeJS.ProcessEnv {
  const env = { ...base, ...credentials.env };
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_DEPLOYMENT;
  return env;
}

function runConvexDeploy(dir: string, extra: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn('npx', ['--yes', 'convex', 'deploy', ...extra], {
      cwd: dir,
      env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      process.stderr.write(`${status.err(`could not run npx convex deploy: ${error.message}`)}\n`);
      done(1);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

async function deployCommand(
  rest: string[],
  extra: string[],
  options: ContextOptions,
): Promise<number> {
  const dir = resolve(takeFlagValue(rest, ['--dir']) ?? '.');
  const name = rest.find((value) => !value.startsWith('-'));
  if (!name) return fail('deploy needs a backend name');
  const invalid = validName(name);
  if (invalid) return fail(invalid);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return fail(`${dir} is not a directory`);
  if (!existsSync(join(dir, 'convex')) && !existsSync(join(dir, 'convex.json'))) {
    return fail(`${dir} has no convex/ folder and no convex.json. Run this in a Convex project or pass --dir.`);
  }
  const ctx = await context(options);
  if (!ctx) return 1;
  const credentials = await scoped(ctx, async () => {
    let backend = findBackend(await ctx.backends.list(), name);
    if (!backend) {
      backend = await createBackend(ctx, name, false);
      process.stderr.write(`${status.ok(`created backend ${backend.name}`)}\n`);
    } else if (backend.status === 'provisioning') {
      backend = await ctx.backends.waitUntilRunning(backend.backend_id);
    }
    return ctx.backends.credentials(backend.backend_id);
  });
  process.stderr.write(`${C.dim}Deploying ${dir} to ${credentials.url}${C.reset}\n`);
  return runConvexDeploy(dir, extra, convexDeployEnv(process.env, credentials));
}

async function deleteCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('delete needs a backend name or id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await scoped(ctx, () => resolveBackend(ctx.backends, target));
  if (!yes) {
    const ok = await confirm(
      `Delete backend ${C.bold}${backend.name}${C.reset}? Its database and files are destroyed.`,
      false,
      { onEndOfInput: false },
    );
    if (!ok) {
      process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
      return 0;
    }
  }
  await scoped(ctx, () => ctx.backends.remove(backend.backend_id));
  if (json) emitJson({ ok: true, backend_id: backend.backend_id, name: backend.name });
  else process.stdout.write(`\n  ${status.ok(`deleted ${backend.name}`)}\n\n`);
  return 0;
}

