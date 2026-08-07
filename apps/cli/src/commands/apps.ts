import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppBlockV2 } from '@kortix/manifest-schema';
import type {
  App,
  AppDeployment,
  AppHostingProvider,
  AppSource,
  ProjectHandle,
} from '@kortix/sdk';
import ignore from 'ignore';
import * as tar from 'tar';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import { loadAuth, loadAuthForHost } from '../api/auth.ts';
import { hasEnvTokenHost } from '../api/config.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { loadLocalManifest } from '../manifest.ts';
import { loadLink, resolveProjectId } from '../project-link.ts';

const HELP = help`Usage: kortix apps <subcommand> [options]

Deploy and operate serverless Kortix Apps. Each App owns one stable URL.
Deployments are immutable. A failed deployment never replaces live traffic.

Subcommands:
  list | ls                         List Apps. --json.
  create <slug>                     Create an App without deploying it.
    --name <name>                   Defaults to the slug.
    --cpu <cores>                   Default: 1.
    --memory <gb>                   Default: 2.
    --disk <gb>                     Default: 10.
    --idle-timeout <seconds>        Default: 300.
    --budget <usd>                  Monthly compute budget. Default: 5.
  deploy [path]                     Deploy a directory or .tar.gz archive.
    --manifest-app <name>           Use one apps.<name> block from kortix.yaml.
    --app <id|slug>                 Existing App. Omit to create one.
    --slug <slug> --name <name>     New App identity.
    --type static|bundle|dockerfile Source type. Auto-detected for directories.
    --image <oci-reference>         Deploy a public OCI image instead of a path.
    --command <json|string>         Process argv. JSON array is unambiguous.
    --port <port>                   Required for Dockerfile and OCI deployments.
    --dockerfile <path>             Default: Dockerfile.
    --root <path>                   Static root inside the archive.
    --output-dir <path>             Bundle output. Default: dist.
    --install-command <command>     Bundle install command.
    --build-command <command>       Bundle build command.
    --readiness-path <path>         Default: /.
    --spa | --no-spa                Static/bundle history fallback.
    --provider <name>               daytona, platinum, e2b, or local-docker.
    --no-wait                       Return after the deployment is queued.
    --wait-seconds <seconds>        Default: 1200.
  show <id|slug>                    Show an App and its deployments. --json.
  logs <id|slug> [deployment-id]    Read runtime logs. --after N --limit N.
  start <id|slug>                   Permit requests and start the App.
  stop <id|slug>                    Suspend now. The next public request wakes it.
  rollback <id|slug> <deployment>   Move traffic to a ready deployment.
  delete <id|slug>                  Delete the App and its runtimes. --yes.

Global options:
  --project <id>     Operate on this project id.
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.
`;

type AppsHandle = ProjectHandle['apps'];
type ContextOptions = { projectArg?: string; hostArg?: string };

function fail(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}

function positiveNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function positiveInteger(value: string | undefined, label: string): number | undefined {
  const number = positiveNumber(value, label);
  if (number !== undefined && !Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function slugFrom(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  if (!slug) throw new Error('Could not derive an App slug; pass --slug');
  return slug;
}

function commandArg(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim().startsWith('[')) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string' && item)) {
      throw new Error('--command JSON must be a non-empty string array');
    }
    return parsed;
  }

  const args: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) throw new Error('--command contains an unfinished escape or quote');
  if (current) args.push(current);
  if (args.length === 0) throw new Error('--command cannot be empty');
  return args;
}

async function context(options: ContextOptions): Promise<{
  projectId: string;
  auth: NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>['auth'];
  apps: AppsHandle;
} | null> {
  const resolved = await resolveProjectContext(options);
  if (!resolved) return null;
  const kortix = kortixFromAuth(resolved.auth);
  const project = await withKortixScope(resolved.auth, () =>
    kortix.project(resolved.projectId).get(),
  );
  if (project.experimental?.apps !== true) {
    process.stderr.write(
      `${status.err('Apps is not enabled for this project.')} Enable Apps in Project Settings → Experimental.\n`,
    );
    return null;
  }
  return {
    projectId: resolved.projectId,
    auth: resolved.auth,
    apps: kortix.project(resolved.projectId).apps,
  };
}

/** Read-only landing-page discovery. Missing auth, project, or flag stays dark. */
export async function selectedProjectAppsEnabled(): Promise<boolean> {
  const projectId = resolveProjectId();
  if (!projectId) return false;
  const linkedHost = hasEnvTokenHost() ? undefined : loadLink()?.host;
  const auth = linkedHost ? loadAuthForHost(linkedHost) : loadAuth();
  if (!auth?.token) return false;
  try {
    const kortix = kortixFromAuth(auth);
    const project = await withKortixScope(auth, () => kortix.project(projectId).get());
    return project.experimental?.apps === true;
  } catch {
    return false;
  }
}

async function scoped<T>(ctx: NonNullable<Awaited<ReturnType<typeof context>>>, fn: () => Promise<T>) {
  return withKortixScope(ctx.auth, fn);
}

async function resolveApp(apps: AppsHandle, target: string): Promise<App> {
  const rows = await apps.list();
  const app = rows.find((row) => row.app_id === target || row.slug === target);
  if (!app) throw new Error(`App ${target} not found`);
  return app;
}

function renderApps(apps: App[]): number {
  if (apps.length === 0) {
    process.stdout.write(`\n  ${C.dim}No Apps deployed.${C.reset}\n\n`);
    return 0;
  }
  const slugWidth = Math.max(4, ...apps.map((app) => app.slug.length));
  process.stdout.write(`\n  ${C.bold}${pad('SLUG', slugWidth)}  STATE     URL${C.reset}\n`);
  for (const app of apps) {
    process.stdout.write(`  ${pad(app.slug, slugWidth)}  ${pad(app.desired_state, 9)} ${app.url}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function takeCommon(rest: string[]) {
  const json = takeFlagBool(rest, ['--json']);
  return {
    json,
    options: {
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
    },
  };
}

export async function runApps(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    const helpArgs = argv.slice(1);
    const helpContext = await context({
      projectArg: takeFlagValue(helpArgs, ['--project']),
      hostArg: takeFlagValue(helpArgs, ['--host']),
    });
    if (!helpContext) return 2;
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const subcommand = argv[0];
  const rest = argv.slice(1);
  try {
    const common = takeCommon(rest);
    switch (subcommand) {
      case 'list':
      case 'ls':
        return await listCommand(common.options, common.json);
      case 'create':
      case 'new':
        return await createCommand(rest, common.options, common.json);
      case 'deploy':
        return await deployCommand(rest, common.options, common.json);
      case 'show':
      case 'get':
        return await showCommand(rest, common.options, common.json);
      case 'logs':
        return await logsCommand(rest, common.options, common.json);
      case 'start':
      case 'stop':
        return await stateCommand(subcommand, rest, common.options, common.json);
      case 'rollback':
        return await rollbackCommand(rest, common.options, common.json);
      case 'delete':
      case 'rm':
      case 'remove':
        return await deleteCommand(rest, common.options, common.json);
      default:
        return fail(`unknown Apps subcommand "${subcommand}"`);
    }
  } catch (error) {
    return surfaceApiError(error);
  }
}

async function listCommand(options: ContextOptions, json: boolean): Promise<number> {
  const ctx = await context(options);
  if (!ctx) return 1;
  const apps = await scoped(ctx, () => ctx.apps.list());
  if (json) {
    emitJson({ apps });
    return 0;
  }
  return renderApps(apps);
}

async function createCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const slugInput = rest.find((value) => !value.startsWith('-'));
  if (!slugInput) return fail('create needs a slug');
  rest.splice(rest.indexOf(slugInput), 1);
  const slug = slugFrom(slugInput);
  const input = {
    slug,
    name: takeFlagValue(rest, ['--name']) ?? slugInput,
    cpu: positiveInteger(takeFlagValue(rest, ['--cpu']), '--cpu'),
    memory_gb: positiveInteger(takeFlagValue(rest, ['--memory']), '--memory'),
    disk_gb: positiveInteger(takeFlagValue(rest, ['--disk']), '--disk'),
    idle_timeout_seconds: positiveInteger(
      takeFlagValue(rest, ['--idle-timeout']),
      '--idle-timeout',
    ),
    monthly_budget_usd: positiveNumber(takeFlagValue(rest, ['--budget']), '--budget'),
  };
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, () => ctx.apps.create(input));
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`created ${app.slug}`)}\n  ${app.url}\n\n`);
  return 0;
}

interface DeployFlags {
  app?: string;
  slug?: string;
  name?: string;
  type?: string;
  image?: string;
  command?: string[];
  port?: number;
  dockerfile?: string;
  root?: string;
  outputDir?: string;
  installCommand?: string;
  buildCommand?: string;
  readinessPath?: string;
  spa?: boolean;
  provider?: AppHostingProvider;
  wait: boolean;
  waitSeconds: number;
  includeNodeModules: boolean;
  manifestApp?: string;
}

function deployFlags(rest: string[]): DeployFlags {
  const provider = takeFlagValue(rest, ['--provider']) as AppHostingProvider | undefined;
  if (provider && !['daytona', 'platinum', 'e2b', 'local-docker'].includes(provider)) {
    throw new Error('--provider must be daytona, platinum, e2b, or local-docker');
  }
  const spa = takeFlagBool(rest, ['--spa']);
  const noSpa = takeFlagBool(rest, ['--no-spa']);
  if (spa && noSpa) throw new Error('Use only one of --spa and --no-spa');
  const waitSeconds = positiveInteger(
    takeFlagValue(rest, ['--wait-seconds']),
    '--wait-seconds',
  ) ?? 1200;
  return {
    app: takeFlagValue(rest, ['--app']),
    slug: takeFlagValue(rest, ['--slug']),
    name: takeFlagValue(rest, ['--name']),
    type: takeFlagValue(rest, ['--type']),
    image: takeFlagValue(rest, ['--image']),
    command: commandArg(takeFlagValue(rest, ['--command', '--cmd'])),
    port: positiveInteger(takeFlagValue(rest, ['--port']), '--port'),
    dockerfile: takeFlagValue(rest, ['--dockerfile']),
    root: takeFlagValue(rest, ['--root']),
    outputDir: takeFlagValue(rest, ['--output-dir']),
    installCommand: takeFlagValue(rest, ['--install-command']),
    buildCommand: takeFlagValue(rest, ['--build-command']),
    readinessPath: takeFlagValue(rest, ['--readiness-path']),
    spa: spa ? true : noSpa ? false : undefined,
    provider,
    wait: !takeFlagBool(rest, ['--no-wait']),
    waitSeconds,
    includeNodeModules: takeFlagBool(rest, ['--include-node-modules']),
    manifestApp: takeFlagValue(rest, ['--manifest-app']),
  };
}

interface ManifestAppDefaults {
  name: string;
  root: string;
  block: AppBlockV2;
}

export function loadManifestAppDefaults(
  cwd: string,
  requestedName?: string,
  allowSingleDefault = false,
): ManifestAppDefaults | null {
  const manifest = loadLocalManifest(cwd);
  if (!manifest || manifest.data.kortix_version !== 2) return null;
  const rawApps = manifest.data.apps;
  if (!rawApps || typeof rawApps !== 'object' || Array.isArray(rawApps)) return null;
  const entries = Object.entries(rawApps as Record<string, AppBlockV2>);
  const selected = requestedName
    ? entries.find(([name]) => name === requestedName)
    : allowSingleDefault && entries.length === 1 ? entries[0] : undefined;
  if (!selected) {
    if (requestedName) throw new Error(`kortix.yaml has no apps.${requestedName} block`);
    return null;
  }
  return { name: selected[0], root: dirname(manifest.path), block: selected[1] };
}

function inferSourceType(root: string, explicit?: string): 'static' | 'bundle' | 'dockerfile' {
  if (explicit) {
    if (!['static', 'bundle', 'dockerfile'].includes(explicit)) {
      throw new Error('--type must be static, bundle, or dockerfile');
    }
    return explicit as 'static' | 'bundle' | 'dockerfile';
  }
  if (existsSync(join(root, 'Dockerfile'))) return 'dockerfile';
  if (existsSync(join(root, 'package.json'))) return 'bundle';
  return 'static';
}

function buildSource(kind: 'static' | 'bundle' | 'dockerfile', flags: DeployFlags): AppSource {
  if (kind === 'static') {
    return {
      kind,
      ...(flags.root ? { root: flags.root } : {}),
      ...(flags.spa !== undefined ? { spa: flags.spa } : {}),
      ...(flags.readinessPath ? { readiness_path: flags.readinessPath } : {}),
    };
  }
  if (kind === 'bundle') {
    return {
      kind,
      ...(flags.installCommand ? { install_command: flags.installCommand } : {}),
      ...(flags.buildCommand ? { build_command: flags.buildCommand } : {}),
      ...(flags.outputDir ? { output_dir: flags.outputDir } : {}),
      ...(flags.spa !== undefined ? { spa: flags.spa } : {}),
      ...(flags.readinessPath ? { readiness_path: flags.readinessPath } : {}),
    };
  }
  if (!flags.command || !flags.port) {
    throw new Error('Dockerfile deployments require --command and --port');
  }
  return {
    kind,
    command: flags.command,
    port: flags.port,
    ...(flags.dockerfile ? { dockerfile: flags.dockerfile } : {}),
    ...(flags.readinessPath ? { readiness_path: flags.readinessPath } : {}),
  };
}

export async function archiveAppDirectory(source: string, includeNodeModules: boolean): Promise<{
  bytes: Uint8Array;
  cleanup: () => Promise<void>;
}> {
  const temporary = await mkdtemp(join(tmpdir(), 'kortix-app-cli-'));
  const output = join(temporary, 'source.tar.gz');
  const matcher = ignore();
  for (const filename of ['.gitignore', '.dockerignore', '.kortixignore']) {
    const path = join(source, filename);
    if (existsSync(path)) matcher.add(await readFile(path, 'utf8'));
  }
  matcher.add([
    '.git',
    '.git/**',
    '**/.git',
    '**/.git/**',
    '.kortix',
    '.kortix/**',
    '**/.kortix',
    '**/.kortix/**',
    '.env*',
    '**/.env*',
    ...(includeNodeModules ? [] : ['node_modules', 'node_modules/**', '**/node_modules/**']),
  ]);
  await tar.c(
    {
      cwd: source,
      file: output,
      gzip: true,
      portable: true,
      noMtime: true,
      filter: (entry) => {
        const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
        return normalized === '' || normalized === '.' || !matcher.ignores(normalized);
      },
    },
    ['.'],
  );
  return {
    bytes: new Uint8Array(await readFile(output)),
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}

export async function readAppArchive(source: string): Promise<Uint8Array> {
  const file = await open(source, 'r');
  try {
    const sourceStats = await file.stat();
    if (!sourceStats.isFile()) {
      throw new Error('Source archive must be a regular file');
    }
    return new Uint8Array(await file.readFile());
  } finally {
    await file.close();
  }
}

async function waitForDeployment(
  apps: AppsHandle,
  appId: string,
  deployment: AppDeployment,
  waitSeconds: number,
): Promise<AppDeployment> {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = deployment;
  let polls = 0;
  while (!['ready', 'failed', 'cancelled'].includes(current.status)) {
    if (Date.now() >= deadline) throw new Error(`Deployment did not finish within ${waitSeconds} seconds`);
    await Bun.sleep(polls < 40 ? 500 : polls < 100 ? 1_000 : 2_000);
    polls += 1;
    current = (await apps.deployments.get(appId, deployment.deployment_id)).deployment;
  }
  if (current.status !== 'ready') {
    throw new Error(current.error || `Deployment ${current.status}`);
  }
  return current;
}

async function deployCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  let flags = deployFlags(rest);
  const pathArgument = rest.find((value) => !value.startsWith('-'));
  if (rest.some((value) => value.startsWith('-'))) {
    throw new Error(`Unknown deploy option ${rest.find((value) => value.startsWith('-'))}`);
  }
  const manifestDefaults = loadManifestAppDefaults(
    process.cwd(),
    flags.manifestApp,
    !pathArgument && !flags.image,
  );
  const manifestBlock = manifestDefaults?.block;
  flags = {
    ...flags,
    type: flags.type ?? manifestBlock?.type,
    image: flags.image ?? manifestBlock?.image,
    command: flags.command ?? manifestBlock?.command,
    port: flags.port ?? manifestBlock?.port,
    dockerfile: flags.dockerfile ?? manifestBlock?.dockerfile,
    root: flags.root ?? manifestBlock?.root,
    outputDir: flags.outputDir ?? manifestBlock?.output_dir,
    installCommand: flags.installCommand ?? manifestBlock?.install_command,
    buildCommand: flags.buildCommand ?? manifestBlock?.build_command,
    readinessPath: flags.readinessPath ?? manifestBlock?.readiness_path,
    spa: flags.spa ?? manifestBlock?.spa,
  };
  if (flags.image && pathArgument) throw new Error('Use a source path or --image, not both');
  const sourcePath = flags.image
    ? undefined
    : pathArgument
      ? resolve(pathArgument)
      : resolve(manifestDefaults?.root ?? process.cwd(), manifestBlock?.path ?? '.');
  if (sourcePath && !existsSync(sourcePath)) throw new Error(`Source path does not exist: ${sourcePath}`);

  const ctx = await context(options);
  if (!ctx) return 1;
  return scoped(ctx, async () => {
    let app: App;
    if (flags.app) {
      app = await resolveApp(ctx.apps, flags.app);
    } else if (manifestDefaults) {
      const manifestSlug = slugFrom(flags.slug ?? manifestDefaults.name);
      const existing = (await ctx.apps.list()).find((row) => row.slug === manifestSlug);
      const settings = {
        ...(manifestBlock?.resources?.cpu !== undefined ? { cpu: manifestBlock.resources.cpu } : {}),
        ...(manifestBlock?.resources?.memory_gb !== undefined ? { memory_gb: manifestBlock.resources.memory_gb } : {}),
        ...(manifestBlock?.resources?.disk_gb !== undefined ? { disk_gb: manifestBlock.resources.disk_gb } : {}),
        ...(manifestBlock?.idle_timeout_seconds !== undefined ? { idle_timeout_seconds: manifestBlock.idle_timeout_seconds } : {}),
        ...(manifestBlock?.monthly_budget_usd !== undefined ? { monthly_budget_usd: manifestBlock.monthly_budget_usd } : {}),
      };
      app = existing
        ? await ctx.apps.update(existing.app_id, settings)
        : await ctx.apps.create({
            slug: manifestSlug,
            name: flags.name ?? manifestDefaults.name,
            ...settings,
          });
    } else {
      const inferred = flags.image ? flags.image.split('/').pop()!.split(':')[0]! : basename(sourcePath!);
      const slug = slugFrom(flags.slug ?? inferred);
      app = await ctx.apps.create({ slug, name: flags.name ?? slug });
    }

    let artifactId: string;
    let source: AppSource;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      if (flags.image) {
        if (!flags.command || !flags.port) throw new Error('OCI deployments require --command and --port');
        const registered = await ctx.apps.artifacts.register({ kind: 'oci_image', image: flags.image });
        artifactId = registered.artifact.artifact_id;
        source = {
          kind: 'oci_image',
          image: flags.image,
          command: flags.command,
          port: flags.port,
          ...(flags.readinessPath ? { readiness_path: flags.readinessPath } : {}),
        };
      } else {
        const sourceStats = await stat(sourcePath!);
        let bytes: Uint8Array;
        let inferenceRoot = sourcePath!;
        if (sourceStats.isDirectory()) {
          const archived = await archiveAppDirectory(sourcePath!, flags.includeNodeModules);
          bytes = archived.bytes;
          cleanup = archived.cleanup;
        } else if (/\.(?:tar\.gz|tgz)$/i.test(sourcePath!)) {
          bytes = await readAppArchive(sourcePath!);
          inferenceRoot = process.cwd();
        } else {
          throw new Error('Source must be a directory, .tar.gz, or .tgz archive');
        }
        const kind = inferSourceType(inferenceRoot, flags.type);
        source = buildSource(kind, flags);
        const artifact = await ctx.apps.artifacts.uploadArchive(bytes, {
          onProgress: (uploaded, total) => {
            if (!json && uploaded === total) process.stderr.write(`${C.dim}Uploaded ${total} bytes.${C.reset}\n`);
          },
        });
        artifactId = artifact.artifact_id;
      }

      let deployment = await ctx.apps.deployments.create(app.app_id, {
        artifact_id: artifactId,
        source,
        ...(flags.provider ? { provider: flags.provider } : {}),
        ...(manifestBlock?.env ? { environment: manifestBlock.env } : {}),
        ...(manifestBlock?.secrets ? { secrets: manifestBlock.secrets } : {}),
      });
      if (flags.wait) deployment = await waitForDeployment(ctx.apps, app.app_id, deployment, flags.waitSeconds);
      const currentApp = flags.wait ? await ctx.apps.get(app.app_id) : app;
      if (json) emitJson({ app: currentApp, deployment });
      else {
        process.stdout.write(`\n  ${status.ok(`deployment ${deployment.status}`)}\n  ${currentApp.url}\n\n`);
      }
      return 0;
    } finally {
      await cleanup?.();
    }
  });
}

async function showCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('show needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    return { app, deployments: await ctx.apps.deployments.list(app.app_id) };
  });
  if (json) emitJson(result);
  else {
    process.stdout.write(`\n  ${C.bold}${result.app.name}${C.reset}\n  ${result.app.url}\n`);
    for (const deployment of result.deployments) {
      process.stdout.write(`  v${deployment.version}  ${deployment.status}  ${deployment.deployment_id}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

async function logsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const after = positiveInteger(takeFlagValue(rest, ['--after']), '--after') ?? 0;
  const limit = positiveInteger(takeFlagValue(rest, ['--limit']), '--limit') ?? 200;
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0]) return fail('logs needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const logs = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, positional[0]!);
    const deploymentId = positional[1] ?? app.active_deployment_id ??
      (await ctx.apps.deployments.list(app.app_id))[0]?.deployment_id;
    if (!deploymentId) throw new Error('App has no deployment');
    return ctx.apps.deployments.logs(app.app_id, deploymentId, { after, limit });
  });
  if (json) emitJson(logs);
  else for (const entry of logs.entries) process.stdout.write(`${entry.time} ${entry.source}  ${entry.line}\n`);
  return 0;
}

async function stateCommand(
  action: 'start' | 'stop',
  rest: string[],
  options: ContextOptions,
  json: boolean,
): Promise<number> {
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail(`${action} needs an App id or slug`);
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    return action === 'start' ? ctx.apps.start(found.app_id) : ctx.apps.stop(found.app_id);
  });
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`${app.slug} ${app.desired_state}`)}\n  ${app.url}\n\n`);
  return 0;
}

async function rollbackCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const positional = rest.filter((value) => !value.startsWith('-'));
  if (!positional[0] || !positional[1]) return fail('rollback needs an App and deployment id');
  const ctx = await context(options);
  if (!ctx) return 1;
  const app = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, positional[0]!);
    return ctx.apps.rollback(found.app_id, positional[1]!);
  });
  if (json) emitJson(app);
  else process.stdout.write(`\n  ${status.ok(`traffic moved to ${positional[1]}`)}\n  ${app.url}\n\n`);
  return 0;
}

async function deleteCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const yes = takeFlagBool(rest, ['--yes', '-y']);
  const target = rest.find((value) => !value.startsWith('-'));
  if (!target) return fail('delete needs an App id or slug');
  if (!yes) return fail('delete is destructive; pass --yes');
  const ctx = await context(options);
  if (!ctx) return 1;
  const result = await scoped(ctx, async () => {
    const app = await resolveApp(ctx.apps, target);
    await ctx.apps.remove(app.app_id);
    return { ok: true, app_id: app.app_id, slug: app.slug };
  });
  if (json) emitJson(result);
  else process.stdout.write(`\n  ${status.ok(`deleted ${result.slug}`)}\n\n`);
  return 0;
}
