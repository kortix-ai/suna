import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { OPENCODE_VERSION } from '@kortix/shared';
import * as tar from 'tar';

import { C, status } from './style.ts';

/**
 * Resolves the `opencode` binary that `kortix connect` hands the terminal to.
 *
 * The TUI is a client of the OpenCode server running inside the session
 * sandbox, and the two are only guaranteed compatible at the same version —
 * the sandbox pin lives in @kortix/shared runtime-versions.json. So instead of
 * requiring users to install and version-manage OpenCode themselves, the CLI
 * keeps per-version managed binaries under ~/.kortix/opencode/<version>/ and
 * downloads the missing one from the npm registry on first use (the same
 * platform packages the official installer uses).
 */

export interface OpencodeBinResolution {
  /** Executable to spawn — an absolute managed path, or a PATH lookup name. */
  bin: string;
  source: 'env' | 'managed' | 'path' | 'downloaded' | 'path-fallback';
  /** Version the binary is known to be; null when unverifiable (env override). */
  version: string | null;
}

export interface EnsureOpencodeBinOpts {
  /** Exact server version to match; defaults to the runtime-versions pin. */
  version?: string;
  /** Test seam for the registry download. */
  fetchImpl?: typeof fetch;
  /** Test seam for the `opencode --version` PATH probe. */
  probePathVersion?: () => string | null;
}

function managedRoot(): string {
  return process.env.KORTIX_OPENCODE_DIR || join(homedir(), '.kortix', 'opencode');
}

export function managedOpencodePath(version: string): string {
  return join(managedRoot(), version, 'opencode');
}

/** Pull an X.Y.Z(-tag) out of whatever `opencode --version` prints. */
export function parseOpencodeVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * npm platform package holding the prebuilt binary, e.g. `opencode-darwin-arm64`.
 * Throws on platforms OpenCode does not publish for.
 */
export function opencodePlatformPackage(
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = isMuslLinux(platform),
): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  if (!os || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error(
      `No prebuilt OpenCode binary for ${platform}/${arch}. ` +
        'Install OpenCode yourself and set KORTIX_OPENCODE_BIN.',
    );
  }
  return `opencode-${os}-${arch}${os === 'linux' && musl ? '-musl' : ''}`;
}

function isMuslLinux(platform: string): boolean {
  return platform === 'linux' && existsSync('/etc/alpine-release');
}

function probeOpencodeOnPath(): string | null {
  try {
    const probe = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) return null;
    return parseOpencodeVersion(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`);
  } catch {
    return null;
  }
}

/**
 * Resolution order:
 *   1. `KORTIX_OPENCODE_BIN` — explicit user override, used as-is.
 *   2. Managed binary already cached for the wanted version.
 *   3. `opencode` on PATH when its `--version` matches exactly.
 *   4. Download the exact version from the npm registry into the cache.
 * A failed download degrades to any PATH binary (with a version-skew warning)
 * before giving up, so an offline machine that has OpenCode still connects.
 */
export async function ensureOpencodeBin(
  opts: EnsureOpencodeBinOpts = {},
): Promise<OpencodeBinResolution> {
  const envBin = process.env.KORTIX_OPENCODE_BIN;
  if (envBin) return { bin: envBin, source: 'env', version: null };

  const version = opts.version ?? OPENCODE_VERSION;
  const managed = managedOpencodePath(version);
  if (existsSync(managed)) return { bin: managed, source: 'managed', version };

  const probe = opts.probePathVersion ?? probeOpencodeOnPath;
  const pathVersion = probe();
  if (pathVersion === version) return { bin: 'opencode', source: 'path', version };

  try {
    await downloadOpencode(version, managed, opts.fetchImpl);
    return { bin: managed, source: 'downloaded', version };
  } catch (err) {
    const reason = (err as Error).message;
    if (pathVersion) {
      process.stderr.write(
        `${status.warn(`Could not download OpenCode v${version} (${reason}).`)}\n` +
          `  ${C.dim}Falling back to \`opencode\` v${pathVersion} from PATH — the session server runs v${version}, so the TUI may misbehave.${C.reset}\n`,
      );
      return { bin: 'opencode', source: 'path-fallback', version: pathVersion };
    }
    throw new Error(
      `Could not download OpenCode v${version}: ${reason}. ` +
        'Install OpenCode (https://opencode.ai) or set KORTIX_OPENCODE_BIN.',
    );
  }
}

async function downloadOpencode(
  version: string,
  dest: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const pkg = opencodePlatformPackage();
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
  process.stderr.write(
    `${C.dim}Downloading OpenCode v${version} (~40 MB, one-time per version)…${C.reset}\n`,
  );

  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);

  const scratch = mkdtempSync(join(tmpdir(), 'kortix-opencode-'));
  try {
    const tgz = join(scratch, 'opencode.tgz');
    // Buffer before writing: `Bun.write(path, response)` can hang forever on a
    // streamed 40 MB body, while arrayBuffer() drains it in seconds.
    await Bun.write(tgz, await response.arrayBuffer());
    await tar.x({ file: tgz, cwd: scratch });
    const extracted = join(scratch, 'package', 'bin', 'opencode');
    if (!existsSync(extracted)) {
      throw new Error(`${pkg}@${version} tarball did not contain package/bin/opencode`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    // Stage in the destination directory, then rename: a concurrent `kortix`
    // downloading the same version must never see a half-written executable.
    const staging = `${dest}.${process.pid}.staging`;
    copyFileSync(extracted, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, dest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
