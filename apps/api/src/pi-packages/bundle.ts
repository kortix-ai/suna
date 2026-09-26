/**
 * Project pi packages (kortix.yaml `harnesses.pi.packages`), built once per
 * package list and shared by every session and project that asks for it.
 *
 * A session must never `npm install` at boot (13.2 s for two packages,
 * measured), and the sandbox image is shared across projects, so the npm
 * sources are installed HERE: `bun install` for the sandbox's platform
 * (linux-x64, even on a macOS API) into a temp dir, packed as one
 * `node_modules` tar.gz, and stored content-addressed in the project-snapshot
 * bucket. The session env carries a short-lived download URL and the digest;
 * the daemon unpacks it before pi starts
 * (apps/kortix-sandbox-agent-server/src/harness/pi/extensions/bundle.ts).
 *
 * A change-request merge builds the new list ahead of the next session. A
 * session that finds no bundle starts the build and boots without the project
 * packages; the daemon reports them as not installed.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PI_SUPPLIED_PACKAGES } from '@kortix/shared';
import { config } from '../config';
import { PREBUILT_FORMAT } from './prebuild';
import {
  headObject,
  presignProjectSnapshotDownload,
  projectSnapshotStorageConfigured,
  putObjectIfAbsent,
} from '../git-proxy/project-snapshot-store';

export const PI_PACKAGE_BUNDLE_FORMAT = PREBUILT_FORMAT;
// ponytail: every sandbox provider runs linux-x64 today; key the digest on the
// target and pass it from the session when an arm64 provider lands.
const TARGET = { os: 'linux', cpu: 'x64' } as const;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const NPM_SOURCE_RE = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The npm sources of a package list as `name@version`, sorted and unique. Paths and malformed entries are skipped. */
export function piPackageSpecs(entries: readonly unknown[]): string[] {
  const specs = new Set<string>();
  for (const entry of entries) {
    const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
    const match = typeof source === 'string' ? NPM_SOURCE_RE.exec(source) : null;
    if (match) specs.add(`${match[1]}@${match[2]}`);
  }
  return [...specs].sort();
}

/** One digest per (format, target, package list): equal lists share one bundle. */
export function piPackageBundleDigest(specs: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ format: PI_PACKAGE_BUNDLE_FORMAT, target: TARGET, specs })).digest('hex');
}

/**
 * `<snapshot prefix>pi-packages/<format>/<digest>.tar.gz` (pre-built, what a
 * session downloads) and `….node_modules.tar.gz` (the installed tree, fetched
 * only for a package that could not be pre-built). Under the same prefix (and
 * bucket policy) as project snapshots.
 */
export function piPackageBundleKey(digest: string, configuredPrefix = config.KORTIX_PROJECT_SNAPSHOT_S3_PREFIX, kind: 'prebuilt' | 'node_modules' = 'prebuilt'): string {
  const trimmed = configuredPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return `${trimmed ? `${trimmed}/` : ''}pi-packages/${PI_PACKAGE_BUNDLE_FORMAT}/${digest}${kind === 'prebuilt' ? '' : '.node_modules'}.tar.gz`;
}

/**
 * The environment of the install and pre-build processes: PATH, HOME, TMPDIR and
 * npm/Bun registry settings only. An inherited NODE_PATH (pnpm's shims set one to
 * the monorepo's store) made the bundler resolve a package's optional require
 * outside the bundle; the API's secrets have no business there either.
 */
export function buildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || key.startsWith('NPM_CONFIG_') || key.startsWith('BUN_CONFIG_')) kept[key] = value;
  }
  return kept;
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env: buildEnv(process.env), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), INSTALL_TIMEOUT_MS);
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`${cmd[0]} ${cmd[1]} exited ${code}: ${stderr.trim().slice(-600)}`);
}

const PEER_PASSES = 3;

/**
 * Required peers that no installed package satisfies, as name → range. pi's
 * own installer (npm) installs peers; bun does not, so the build adds them.
 * pi-supplied names and optional peers never count.
 */
export async function missingPeers(nodeModules: string): Promise<Record<string, string>> {
  const installed = new Set<string>();
  const manifests: Array<{ peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }> = [];
  const read = async (name: string) => {
    try {
      manifests.push(JSON.parse(await readFile(join(nodeModules, name, 'package.json'), 'utf8')));
      installed.add(name);
    } catch {
      // not a package directory
    }
  };
  for (const entry of await readdir(nodeModules).catch(() => [] as string[])) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of await readdir(join(nodeModules, entry)).catch(() => [] as string[])) await read(`${entry}/${scoped}`);
    } else {
      await read(entry);
    }
  }
  const missing: Record<string, string> = {};
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (installed.has(name) || PI_SUPPLIED_PACKAGES.includes(name) || manifest.peerDependenciesMeta?.[name]?.optional) continue;
      missing[name] ??= range;
    }
  }
  return missing;
}

type BundleFile = { path: string; bytes: number };
export interface BuiltBundle {
  prebuilt: BundleFile;
  nodeModules: BundleFile;
  cleanup: () => Promise<void>;
}

async function pack(dir: string, name: string, what: string[]): Promise<BundleFile> {
  const path = join(dir, name);
  await run(['tar', '-czf', path, ...what], dir);
  const { size } = await stat(path);
  if (size > MAX_BUNDLE_BYTES) throw new Error(`${name} is ${size} bytes; the limit is ${MAX_BUNDLE_BYTES}`);
  return { path, bytes: size };
}

/**
 * Install `specs` for the sandbox target: the packages, their dependencies, and
 * their required peers (as pi's own npm install would), with the pi-supplied
 * packages as empty stubs. Bun never runs dependency lifecycle scripts;
 * `--ignore-scripts` covers the root. Then pre-build (prebuild.ts, its own
 * process) and pack both the pre-built tree and the installed tree.
 */
export async function buildPiPackageBundle(specs: readonly string[]): Promise<BuiltBundle> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-packages-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const dependencies: Record<string, string> = Object.fromEntries(specs.map((spec) => {
      const at = spec.lastIndexOf('@');
      return [spec.slice(0, at), spec.slice(at + 1)];
    }));
    await mkdir(join(dir, 'pi-supplied'));
    await writeFile(join(dir, 'pi-supplied', 'package.json'), JSON.stringify({ name: 'kortix-pi-supplied', version: '0.0.0', private: true }));
    for (const name of PI_SUPPLIED_PACKAGES) dependencies[name] = 'file:./pi-supplied';
    for (let pass = 0; ; pass++) {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'kortix-pi-project-packages', private: true, dependencies }));
      await run(
        ['bun', 'install', '--production', '--linker=hoisted', `--os=${TARGET.os}`, `--cpu=${TARGET.cpu}`, '--ignore-scripts', '--no-save', '--no-progress'],
        dir,
      );
      const missing = await missingPeers(join(dir, 'node_modules'));
      if (Object.keys(missing).length === 0) break;
      if (pass + 1 >= PEER_PASSES) throw new Error(`peer dependencies still missing after ${PEER_PASSES} installs: ${Object.keys(missing).join(', ')}`);
      Object.assign(dependencies, missing);
    }
    const names = specs.map((spec) => spec.slice(0, spec.lastIndexOf('@')));
    await run([process.execPath, join(import.meta.dir, 'prebuild.ts'), join(dir, 'node_modules'), join(dir, 'prebuilt'), ...names], dir);
    const prebuilt = await pack(dir, 'prebuilt.tar.gz', ['-C', 'prebuilt', '.']);
    const nodeModules = await pack(dir, 'node_modules.tar.gz', ['node_modules']);
    return { prebuilt, nodeModules, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export interface BundleDeps {
  head: (key: string) => Promise<unknown | null>;
  put: (key: string, file: BundleFile) => Promise<unknown>;
  build: typeof buildPiPackageBundle;
}

const defaultDeps: BundleDeps = {
  head: headObject,
  put: (key, file) => putObjectIfAbsent({ key, body: file, contentType: 'application/gzip' }),
  build: buildPiPackageBundle,
};

const inflight = new Map<string, Promise<void>>();

/** Build and store the bundle for `specs` unless it exists. One build per digest per process. */
export function ensurePiPackageBundle(specs: readonly string[], deps: BundleDeps = defaultDeps): Promise<void> {
  const digest = piPackageBundleDigest(specs);
  const running = inflight.get(digest);
  if (running) return running;
  const key = piPackageBundleKey(digest);
  const job = (async () => {
    if (await deps.head(key)) return;
    const startedAt = Date.now();
    const bundle = await deps.build(specs);
    try {
      // The installed tree first: the pre-built key existing means both are there.
      await deps.put(piPackageBundleKey(digest, undefined, 'node_modules'), bundle.nodeModules);
      await deps.put(key, bundle.prebuilt);
      console.log('[pi-packages] bundle built', {
        digest,
        specs,
        prebuiltBytes: bundle.prebuilt.bytes,
        nodeModulesBytes: bundle.nodeModules.bytes,
        ms: Date.now() - startedAt,
      });
    } finally {
      await bundle.cleanup();
    }
  })().finally(() => inflight.delete(digest));
  inflight.set(digest, job);
  return job;
}

/** Start the build for a package list and log a failure; never throws. */
export function kickPiPackageBundle(entries: readonly unknown[], context: Record<string, unknown>): void {
  const specs = piPackageSpecs(entries);
  if (specs.length === 0 || !projectSnapshotStorageConfigured()) return;
  void ensurePiPackageBundle(specs).catch((err) => {
    console.warn('[pi-packages] bundle build failed', { ...context, specs, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * The bundle a pi session downloads: its digest and a short-lived URL, or null
 * when the list has no npm source, storage is off, or the bundle is not built
 * yet (the build starts; this session boots without it).
 */
export async function piPackageBundleForSession(
  entries: readonly unknown[],
  context: Record<string, unknown>,
): Promise<{ digest: string; url: string; fallbackUrl: string } | null> {
  const specs = piPackageSpecs(entries);
  if (specs.length === 0 || !projectSnapshotStorageConfigured()) return null;
  const digest = piPackageBundleDigest(specs);
  try {
    if (!(await headObject(piPackageBundleKey(digest)))) {
      kickPiPackageBundle(entries, context);
      return null;
    }
    // Signing is local (no request): the fallback URL costs nothing unless a package needs it.
    const [{ url }, { url: fallbackUrl }] = await Promise.all([
      presignProjectSnapshotDownload(piPackageBundleKey(digest)),
      presignProjectSnapshotDownload(piPackageBundleKey(digest, undefined, 'node_modules')),
    ]);
    return { digest, url, fallbackUrl };
  } catch (err) {
    console.warn('[pi-packages] bundle lookup failed; session boots without project packages', {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
