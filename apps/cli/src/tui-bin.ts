import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { C } from './style.ts';
import { isSupervised, SUPERVISED_NOTICE } from './supervised.ts';

/**
 * Resolves the `kortix-tui` binary that `kortix tui` hands the terminal to.
 *
 * The TUI is NOT in this binary. `@opentui/core` dlopen's an ~18 MB native
 * library per platform and pulls React in with it, which cost every `kortix`
 * user 18–37 MB for a command most never run. So the TUI ships as its own
 * release asset, built by the same job that builds `kortix`
 * (apps/tui/bundle/*), and the CLI keeps per-version copies under
 * ~/.kortix/tui/<version>/ — exactly the shape `ensureOpencodeBin`
 * (src/opencode-bin.ts) already uses for OpenCode.
 *
 * Version-matched on purpose: `kortix-tui` imports @kortix/cli's config reader
 * and @kortix/sdk, so a TUI from another release can disagree with this CLI
 * about the config format or the backend contract. The cache key is the CLI's
 * OWN version, and the download is that version's release asset — never
 * "latest".
 */

export type TuiBinSource = 'env' | 'cache' | 'downloaded';

export interface TuiBinResolution {
  /** Executable to spawn — an absolute path. */
  bin: string;
  source: TuiBinSource;
}

/** The repo whose releases carry the assets. Overridable for forks/tests. */
function releaseRepo(env: NodeJS.ProcessEnv = process.env): string {
  return env.KORTIX_REPO ?? 'kortix-ai/suna';
}

/**
 * Where the release assets live. `KORTIX_TUI_RELEASE_BASE` re-points it at a
 * local HTTP server so the whole download + checksum path can be exercised
 * end-to-end without publishing a release.
 */
export function tuiReleaseBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KORTIX_TUI_RELEASE_BASE?.trim();
  if (override) return override.replace(/\/+$/, '');
  return `https://github.com/${releaseRepo(env)}/releases/download`;
}

/** Root of the managed cache: ~/.kortix/tui/. `kortix uninstall` removes it. */
export function tuiCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.KORTIX_TUI_DIR || join(homedir(), '.kortix', 'tui');
}

/** The cached binary for one version: ~/.kortix/tui/<version>/kortix-tui. */
export function managedTuiPath(version: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(tuiCacheRoot(env), version, 'kortix-tui');
}

/**
 * The version CI bakes into the binary. This MUST read the literal token
 * `process.env.KORTIX_CLI_VERSION`: `bun build --define` substitutes that exact
 * expression and nothing else, so a read through an injected `env` object
 * (`env.KORTIX_CLI_VERSION`) is untouched by the define and answers `undefined`
 * inside the compiled binary — which is how the first published `kortix tui`
 * reported version "dev" while `kortix --version` printed `0.13.25-dev.…`.
 * Same source `src/index.ts` uses for `--version`.
 */
const BAKED_CLI_VERSION: string | undefined = process.env.KORTIX_CLI_VERSION;

/**
 * The CLI's own version — what the TUI is matched against. The baked value
 * wins (a user cannot re-point a release binary at another TUI by exporting a
 * variable); the injected `env` only matters for a source run, where nothing
 * is baked, and that is what the tests exercise.
 */
export function cliVersion(env: NodeJS.ProcessEnv = process.env): string {
  return BAKED_CLI_VERSION ?? env.KORTIX_CLI_VERSION ?? 'dev';
}

/**
 * Strict full-string version check.
 *
 * The version is spliced into BOTH the release-asset URL and the cache path
 * under ~/.kortix, so anything beyond `X.Y.Z(-tag)` — a `/`, a `..`, a newline
 * — would redirect the download or escape the cache directory. Same rule and
 * same reason as `isValidOpencodeVersion`.
 *
 * `dev` is deliberately NOT valid: a source build has no published release to
 * match, and the caller must say so rather than invent a URL.
 */
export function isValidTuiVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version);
}

/**
 * Release tag holding this version's assets.
 *
 * A released CLI is `X.Y.Z` → tag `vX.Y.Z`. A dev-channel CLI is
 * `X.Y.Z-dev.<sha8>` (deploy-dev.yml's `dev-version` job) and its assets live
 * on the mutable `dev-latest` prerelease, which is the only tag that ever
 * carries them.
 */
export function tuiReleaseTag(version: string): string {
  return version.includes('-dev.') ? 'dev-latest' : `v${version}`;
}

/**
 * Release asset for this platform, e.g. `kortix-tui-darwin-arm64`. The four
 * names match apps/tui/bundle/bundle-<target>.sh exactly.
 */
export function tuiPlatformAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  if (!os || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error(
      `No prebuilt kortix-tui binary for ${platform}/${arch} — darwin and linux on arm64/x64 only. Build one yourself (pnpm --filter @kortix/tui bundle) and set KORTIX_TUI_BIN.`,
    );
  }
  return `kortix-tui-${os}-${arch}`;
}

/** `<base>/<tag>/<asset>` — the same scheme scripts/install.sh uses for `kortix`. */
export function tuiAssetUrl(
  version: string,
  asset: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${tuiReleaseBase(env)}/${tuiReleaseTag(version)}/${asset}`;
}

export interface FindTuiBinOpts {
  version?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the filesystem probe. */
  exists?: (path: string) => boolean;
}

/**
 * The binary this machine already has, without touching the network.
 *
 * Order:
 *   1. `KORTIX_TUI_BIN` — explicit override, used as-is (a local build, a
 *      packaged copy, a bisect).
 *   2. ~/.kortix/tui/<version>/kortix-tui — the managed cache for THIS CLI's
 *      version. A source build (`dev`) reads ~/.kortix/tui/dev/kortix-tui, so
 *      dropping a locally built binary there makes `kortix tui` work with no
 *      env var at all.
 *
 * Returns null when neither exists — the caller then asks to download.
 */
export function findTuiBin(opts: FindTuiBinOpts = {}): TuiBinResolution | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const override = env.KORTIX_TUI_BIN?.trim();
  if (override) return { bin: override, source: 'env' };

  const version = opts.version ?? cliVersion(env);
  const managed = managedTuiPath(version, env);
  return exists(managed) ? { bin: managed, source: 'cache' } : null;
}

export interface DownloadTuiBinOpts {
  version: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  /** Test seam for the release download. */
  fetchImpl?: typeof fetch;
  /** Progress/notice sink. Defaults to stderr. */
  log?: (text: string) => void;
}

/**
 * Download this version's `kortix-tui` into the managed cache and return its
 * path.
 *
 * Both the binary and its `.sha256` come from the release. The checksum is
 * verified BEFORE anything becomes executable, and a mismatch leaves nothing
 * behind — the alternative is a half-downloaded or tampered 80 MB binary
 * sitting in the cache that every later run would happily exec.
 */
export async function downloadTuiBin(opts: DownloadTuiBinOpts): Promise<string> {
  const env = opts.env ?? process.env;
  const { version } = opts;
  if (!isValidTuiVersion(version)) {
    throw new Error(`Refusing malformed kortix-tui version "${version}".`);
  }
  // The backstop. `runTui` already refuses before it asks, but this is where
  // the ~80 MB public release asset is actually fetched, so the last word
  // belongs here — same rule as `ensureOpencodeBin`.
  if (isSupervised()) {
    throw new Error(
      `${SUPERVISED_NOTICE} It will not download kortix-tui from a public release. ` +
        'Run `kortix tui` on your own machine instead, or set KORTIX_TUI_BIN.',
    );
  }
  const asset = tuiPlatformAsset(opts.platform, opts.arch);
  const url = tuiAssetUrl(version, asset, env);
  const checksumUrl = `${url}.sha256`;
  const log = opts.log ?? ((text: string) => process.stderr.write(text));

  log(`${C.dim}Downloading kortix-tui v${version} (~80 MB, one-time per version)…${C.reset}\n`);

  // Indirect through `doFetch`, exactly as `downloadOpencode` does: the target
  // is an interpolated release URL, so scripts/sdk-boundary.mjs cannot read its
  // static prefix. The default base is github.com — an allowed origin — and the
  // indirection is also the test seam.
  const doFetch = opts.fetchImpl ?? fetch;

  const binaryResponse = await doFetch(url);
  if (!binaryResponse.ok) throw new Error(`${url} → HTTP ${binaryResponse.status}`);
  // Buffer before writing: `Bun.write(path, response)` can hang forever on a
  // streamed 80 MB body, while arrayBuffer() drains it in seconds (the same
  // trap opencode-bin.ts hit).
  const bytes = new Uint8Array(await binaryResponse.arrayBuffer());

  const checksumResponse = await doFetch(checksumUrl);
  if (!checksumResponse.ok) {
    throw new Error(`${checksumUrl} → HTTP ${checksumResponse.status} (checksum is required)`);
  }
  const expected = parseSha256(await checksumResponse.text());
  if (!expected) throw new Error(`${checksumUrl} did not contain a sha256 digest`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset} — expected ${expected}, got ${actual}`);
  }

  const dest = managedTuiPath(version, env);
  mkdirSync(dirname(dest), { recursive: true });
  // Stage beside the destination, then rename: a second `kortix tui`
  // downloading the same version must never see a half-written executable.
  const staging = `${dest}.${process.pid}.staging`;
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    // `renameSync` is atomic within the directory, so the file only ever
    // appears at `dest` complete and verified.
    renameSync(staging, dest);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  return dest;
}

/** First 64-hex token in a `sha256sum` line (`<hex>  <file>`), or null. */
export function parseSha256(text: string): string | null {
  const match = text.match(/\b([0-9a-f]{64})\b/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** Remove the whole managed cache. Used by `kortix tui --uninstall`. */
export function removeTuiCache(env: NodeJS.ProcessEnv = process.env): string {
  const root = tuiCacheRoot(env);
  rmSync(root, { recursive: true, force: true });
  return root;
}
