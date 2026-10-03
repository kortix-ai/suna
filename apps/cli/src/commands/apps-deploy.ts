import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AppBlockV2 } from '@kortix/manifest-schema';
import type {
  App,
  AppAccessMode,
  AppDeployment,
  AppHostingProvider,
  AppSource,
  ProjectHandle,
} from '@kortix/sdk';
import ignore from 'ignore';
import * as tar from 'tar';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import { resolveProjectContext, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { loadLocalManifest } from '../manifest.ts';
import { C, status } from '../style.ts';

// The `kortix apps` shared plumbing — context resolution and small parse
// helpers every apps subcommand uses — plus the `deploy` pipeline. The
// command bodies live in apps.ts (and apps-access.ts for access).

export type AppsHandle = ProjectHandle['apps'];
export type ContextOptions = { projectArg?: string; hostArg?: string };

export function positiveNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

export function positiveInteger(value: string | undefined, label: string): number | undefined {
  const number = positiveNumber(value, label);
  if (number !== undefined && !Number.isInteger(number))
    throw new Error(`${label} must be an integer`);
  return number;
}

export function slugFrom(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  if (!slug) throw new Error('Could not derive an App slug; pass --slug');
  return slug;
}

export function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function commandArg(value: string | undefined): string[] | undefined {
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

export async function context(options: ContextOptions): Promise<{
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
  // Client-side pre-check: saves a wasted round trip when the flag is off. The
  // wording matches the server's gate verbatim (feature-flags/gate.ts), so the
  // user reads the same sentence whichever side rejects.
  if (project.experimental?.apps !== true) {
    process.stderr.write(
      `${status.err('Apps is not enabled for this project. Enable it in Settings → Feature flags.')}\n`,
    );
    return null;
  }
  return {
    projectId: resolved.projectId,
    auth: resolved.auth,
    apps: kortix.project(resolved.projectId).apps,
  };
}

export async function scoped<T>(
  ctx: NonNullable<Awaited<ReturnType<typeof context>>>,
  fn: () => Promise<T>,
) {
  return withKortixScope(ctx.auth, fn);
}

export async function resolveApp(apps: AppsHandle, target: string): Promise<App> {
  const rows = await apps.list();
  const app = rows.find((row) => row.app_id === target || row.slug === target);
  if (!app) throw new Error(`App ${target} not found`);
  return app;
}

// ── Deploy ──────────────────────────────────────────────────────────────────
// The `kortix apps deploy` pipeline: flag/manifest parsing, App provisioning,
// artifact staging, and the wait loop. `deployCommand` itself stays in apps.ts
// and orchestrates these.

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
  accessMode?: AppAccessMode;
  password?: string;
  memberIds?: string[];
  groupIds?: string[];
}

export function deployFlags(rest: string[]): DeployFlags {
  const provider = takeFlagValue(rest, ['--provider']) as AppHostingProvider | undefined;
  if (provider && !['daytona', 'platinum', 'e2b'].includes(provider)) {
    throw new Error('--provider must be daytona, platinum, or e2b');
  }
  const accessMode = takeFlagValue(rest, ['--access']) as AppAccessMode | undefined;
  if (
    accessMode &&
    !['private', 'project', 'restricted', 'public', 'password'].includes(accessMode)
  ) {
    throw new Error('--access must be private, project, restricted, public, or password');
  }
  const spa = takeFlagBool(rest, ['--spa']);
  const noSpa = takeFlagBool(rest, ['--no-spa']);
  if (spa && noSpa) throw new Error('Use only one of --spa and --no-spa');
  const waitSeconds =
    positiveInteger(takeFlagValue(rest, ['--wait-seconds']), '--wait-seconds') ?? 1200;
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
    accessMode,
    password: takeFlagValue(rest, ['--password']),
    memberIds: csv(takeFlagValue(rest, ['--members'])),
    groupIds: csv(takeFlagValue(rest, ['--groups'])),
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
    : allowSingleDefault && entries.length === 1
      ? entries[0]
      : undefined;
  if (!selected) {
    if (requestedName) throw new Error(`kortix.yaml has no apps.${requestedName} block`);
    return null;
  }
  return { name: selected[0], root: dirname(manifest.path), block: selected[1] };
}

/**
 * Fill the flags a deploy inherited nothing for from the manifest's apps
 * block. Explicit flags always win; the manifest only supplies defaults.
 */
export function mergeManifestDefaults(
  flags: DeployFlags,
  manifestBlock: AppBlockV2 | undefined,
): DeployFlags {
  return {
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

export async function archiveAppDirectory(
  source: string,
  includeNodeModules: boolean,
): Promise<{
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

/**
 * Resolve or create the App a deployment targets: an explicit --app, else the
 * manifest block's identity (updating an existing slug in place), else one
 * derived from the image reference or source path.
 */
export async function provisionDeployApp(
  apps: AppsHandle,
  flags: DeployFlags,
  manifestDefaults: ManifestAppDefaults | null,
  sourcePath: string | undefined,
): Promise<App> {
  if (flags.app) {
    return resolveApp(apps, flags.app);
  }
  if (manifestDefaults) {
    const manifestBlock = manifestDefaults.block;
    const manifestSlug = slugFrom(flags.slug ?? manifestDefaults.name);
    const existing = (await apps.list()).find((row) => row.slug === manifestSlug);
    const settings = {
      ...(manifestBlock?.resources?.cpu !== undefined ? { cpu: manifestBlock.resources.cpu } : {}),
      ...(manifestBlock?.resources?.memory_gb !== undefined
        ? { memory_gb: manifestBlock.resources.memory_gb }
        : {}),
      ...(manifestBlock?.resources?.disk_gb !== undefined
        ? { disk_gb: manifestBlock.resources.disk_gb }
        : {}),
      ...(manifestBlock?.idle_timeout_seconds !== undefined
        ? { idle_timeout_seconds: manifestBlock.idle_timeout_seconds }
        : {}),
      ...(manifestBlock?.monthly_budget_usd !== undefined
        ? { monthly_budget_usd: manifestBlock.monthly_budget_usd }
        : {}),
    };
    return existing
      ? apps.update(existing.app_id, settings)
      : apps.create({
          slug: manifestSlug,
          name: flags.name ?? manifestDefaults.name,
          ...settings,
        });
  }
  const inferred = flags.image
    ? flags.image.split('/').pop()!.split(':')[0]!
    : basename(sourcePath!);
  const slug = slugFrom(flags.slug ?? inferred);
  return apps.create({ slug, name: flags.name ?? slug });
}

/**
 * Turn the source into an uploaded artifact: an OCI image is registered by
 * reference, anything else is archived (or read from a .tar.gz) and uploaded.
 * Returns the temp-dir cleanup so the caller can run it after the deployment
 * flow; a failure inside staging cleans up after itself.
 */
export async function stageArtifact(
  apps: AppsHandle,
  flags: DeployFlags,
  sourcePath: string | undefined,
  json: boolean,
): Promise<{ artifactId: string; source: AppSource; cleanup?: () => Promise<void> }> {
  if (flags.image) {
    if (!flags.command || !flags.port)
      throw new Error('OCI deployments require --command and --port');
    const registered = await apps.artifacts.register({ kind: 'oci_image', image: flags.image });
    return {
      artifactId: registered.artifact.artifact_id,
      source: {
        kind: 'oci_image',
        image: flags.image,
        command: flags.command,
        port: flags.port,
        ...(flags.readinessPath ? { readiness_path: flags.readinessPath } : {}),
      },
    };
  }

  const sourceStats = await stat(sourcePath!);
  let bytes: Uint8Array;
  let inferenceRoot = sourcePath!;
  let cleanup: (() => Promise<void>) | undefined;
  try {
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
    const source = buildSource(kind, flags);
    const artifact = await apps.artifacts.uploadArchive(bytes, {
      onProgress: (uploaded, total) => {
        if (!json && uploaded === total)
          process.stderr.write(`${C.dim}Uploaded ${total} bytes.${C.reset}\n`);
      },
    });
    return { artifactId: artifact.artifact_id, source, cleanup };
  } catch (err) {
    await cleanup?.();
    throw err;
  }
}

export async function waitForDeployment(
  apps: AppsHandle,
  appId: string,
  deployment: AppDeployment,
  waitSeconds: number,
): Promise<AppDeployment> {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = deployment;
  let polls = 0;
  while (!['ready', 'failed', 'cancelled'].includes(current.status)) {
    if (Date.now() >= deadline)
      throw new Error(`Deployment did not finish within ${waitSeconds} seconds`);
    await Bun.sleep(polls < 40 ? 500 : polls < 100 ? 1_000 : 2_000);
    polls += 1;
    current = (await apps.deployments.get(appId, deployment.deployment_id)).deployment;
  }
  if (current.status !== 'ready') {
    throw new Error(current.error || `Deployment ${current.status}`);
  }
  return current;
}
