import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectBackend, ProjectBackendCredentials, ProjectHandle } from '@kortix/sdk';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
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

const HELP = help`Usage: kortix backends <subcommand> [options]

Self-hosted Convex backends. Each backend runs in its own machine. A project
owns up to 3. <name|id> is the backend name or its id.

Subcommands:
  list | ls                         List backends. --json.
  create <name>                     Create and boot a backend. Takes seconds, or
                                    minutes on the first image build. --json.
  get <name|id>                     Show one backend. --json.
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
} | null> {
  const resolved = await resolveProjectContext(options);
  if (!resolved) return null;
  const kortix = kortixFromAuth(resolved.auth);
  const project = await withKortixScope(resolved.auth, () =>
    kortix.project(resolved.projectId).get(),
  );
  if (project.experimental?.backends !== true) {
    process.stderr.write(
      `${status.err('Backends is not enabled for this project. Enable it in Settings → Feature flags.')}\n`,
    );
    return null;
  }
  return { auth: resolved.auth, backends: kortix.project(resolved.projectId).backends };
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
      case 'get':
      case 'show':
        return await getCommand(rest, common.options, common.json);
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

async function createBackend(ctx: Ctx, name: string, quiet: boolean): Promise<ProjectBackend> {
  if (!quiet) {
    process.stderr.write(
      `${C.dim}Creating backend ${name}. This takes seconds, or minutes on the first image build.${C.reset}\n`,
    );
  }
  return scoped(ctx, async () => {
    const created = await ctx.backends.create({ name });
    return ctx.backends.waitUntilRunning(created.backend_id);
  });
}

async function createCommand(
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const name = rest.find((value) => !value.startsWith('-'));
  if (!name) return fail('create needs a backend name');
  const invalid = validName(name);
  if (invalid) return fail(invalid);
  const ctx = await context(options);
  if (!ctx) return 1;
  const backend = await createBackend(ctx, name, json);
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

