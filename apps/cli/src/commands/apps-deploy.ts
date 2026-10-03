/**
 * `kortix apps deploy` internals: the manifest/flag merge, the App the
 * deployment lands on, and the artifact staging (directory vs .tar.gz vs
 * OCI image). Split out of apps.ts so the deploy orchestration reads as one
 * straight line and each of the three jobs is testable on its own.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AppBlockV2 } from '@kortix/manifest-schema';
import type { App, AppAccessMode, AppHostingProvider, AppSource, ProjectHandle } from '@kortix/sdk';
import ignore from 'ignore';
import * as tar from 'tar';

import { C } from '../style.ts';

export type AppsHandle = ProjectHandle['apps'];

export interface DeployFlags {
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

export interface ManifestAppDefaults {
  name: string;
  root: string;
  block: AppBlockV2;
}

// ── 1. The merge: an explicit flag wins, the manifest block fills the rest. ──

export function mergeManifestDefaults(
  flags: DeployFlags,
  block: AppBlockV2 | undefined | null,
): DeployFlags {
  return {
    ...flags,
    type: flags.type ?? block?.type,
    image: flags.image ?? block?.image,
    command: flags.command ?? block?.command,
    port: flags.port ?? block?.port,
    dockerfile: flags.dockerfile ?? block?.dockerfile,
    root: flags.root ?? block?.root,
    outputDir: flags.outputDir ?? block?.output_dir,
    installCommand: flags.installCommand ?? block?.install_command,
    buildCommand: flags.buildCommand ?? block?.build_command,
    readinessPath: flags.readinessPath ?? block?.readiness_path,
    spa: flags.spa ?? block?.spa,
  };
}

// ── 2. Which App the deployment lands on. ────────────────────────────────────

/** `--app` names an existing App (apps.ts resolves it); otherwise the manifest
 *  block updates-or-creates its slug with the block's resource settings, and
 *  with neither the App is named from the image or the source folder. */
export async function provisionDeployApp(
  apps: AppsHandle,
  flags: DeployFlags,
  manifestDefaults: ManifestAppDefaults | null,
  sourcePath: string | undefined,
): Promise<App> {
  const manifestBlock = manifestDefaults?.block;
  if (manifestDefaults) {
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
      ? await apps.update(existing.app_id, settings)
      : await apps.create({
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

// ── 3. Stage the deployable: OCI image by reference, or archived bytes. ──────

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
