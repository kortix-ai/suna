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
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  headObject,
  presignProjectSnapshotDownload,
  projectSnapshotStorageConfigured,
  putObjectIfAbsent,
} from '../git-proxy/project-snapshot-store';

export const PI_PACKAGE_BUNDLE_FORMAT = 'pi-packages-v1';
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

export function piPackageBundleKey(digest: string): string {
  return `pi-packages/${PI_PACKAGE_BUNDLE_FORMAT}/${digest}.tar.gz`;
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), INSTALL_TIMEOUT_MS);
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`${cmd[0]} ${cmd[1]} exited ${code}: ${stderr.trim().slice(-600)}`);
}

/**
 * Install `specs` for the sandbox target and pack `node_modules`. Peers stay
 * out: pi supplies `typebox` and `@earendil-works/pi-*` to every extension.
 * Bun never runs dependency lifecycle scripts; `--ignore-scripts` covers the root.
 */
export async function buildPiPackageBundle(specs: readonly string[]): Promise<{ path: string; bytes: number; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-packages-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const dependencies = Object.fromEntries(specs.map((spec) => {
      const at = spec.lastIndexOf('@');
      return [spec.slice(0, at), spec.slice(at + 1)];
    }));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'kortix-pi-project-packages', private: true, dependencies }));
    await run(
      ['bun', 'install', '--production', '--omit=peer', '--linker=hoisted', `--os=${TARGET.os}`, `--cpu=${TARGET.cpu}`, '--ignore-scripts', '--no-save', '--no-progress'],
      dir,
    );
    const path = join(dir, 'bundle.tar.gz');
    await run(['tar', '-czf', path, 'node_modules'], dir);
    const { size } = await stat(path);
    if (size > MAX_BUNDLE_BYTES) throw new Error(`bundle is ${size} bytes; the limit is ${MAX_BUNDLE_BYTES}`);
    return { path, bytes: size, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export interface BundleDeps {
  head: (key: string) => Promise<unknown | null>;
  put: (key: string, file: { path: string; bytes: number }) => Promise<unknown>;
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
      await deps.put(key, bundle);
      console.log('[pi-packages] bundle built', { digest, specs, bytes: bundle.bytes, ms: Date.now() - startedAt });
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
): Promise<{ digest: string; url: string } | null> {
  const specs = piPackageSpecs(entries);
  if (specs.length === 0 || !projectSnapshotStorageConfigured()) return null;
  const digest = piPackageBundleDigest(specs);
  try {
    if (!(await headObject(piPackageBundleKey(digest)))) {
      kickPiPackageBundle(entries, context);
      return null;
    }
    const { url } = await presignProjectSnapshotDownload(piPackageBundleKey(digest));
    return { digest, url };
  } catch (err) {
    console.warn('[pi-packages] bundle lookup failed; session boots without project packages', {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
