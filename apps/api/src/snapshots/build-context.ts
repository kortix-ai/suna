/**
 * Shared build-context staging for sandbox snapshots.
 *
 * Both providers build the SAME image: the user's Dockerfile + the Kortix
 * runtime layer (agent binary + CLI + entrypoint + slack-cli + executor-sdk +
 * opencode/agent-browser). Daytona ships this context to its build service via
 * `Image.fromDockerfile(ctx)`; Platinum ships it to `POST /v1/templates/
 * from-build`. Staging the context here — once — guarantees the produced image
 * is byte-identical across providers and keeps the artifact paths in one place.
 *
 * Extracted verbatim from the Daytona adapter (no behaviour change); see
 * snapshots/providers/daytona.ts (Daytona) + snapshots/providers/platinum.ts.
 */

import { copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile as writeFileFs } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { AGENT_BROWSER_VERSION, OPENCODE_VERSION } from '@kortix/shared';
import { gatewayModelCatalog } from '../llm-gateway/models/catalog-models';
import { tmpdir } from 'node:os';
import { buildLayeredDockerfile, buildPerProjectWarmFromBaseDockerfile } from './dockerfile-layer';
import { buildStarterFiles, DEFAULT_STARTER_TEMPLATE_ID } from '../projects/starter';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsyncBC = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
// These artifact paths are read LAZILY (per call, not as module-load consts).
// build-context is imported once and shared across the whole `bun test` process;
// tests override KORTIX_SNAPSHOT_* per suite, so module-load consts let the
// first-imported suite's fixtures win and break sibling suites in a combined run.
// In production the env is set once, so reading per-call is behaviour-neutral.
const agentBinPath = () => process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH
  || resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/dist/kortix-agent');
const cliBinPath = () => process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH
  || resolve(REPO_ROOT, 'apps/cli/dist/kortix');
const entrypointSrcPath = () => process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const slackCliSrcPath = () => process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/slack-cli');
const executorSdkSrcPath = () => process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH
  || resolve(REPO_ROOT, 'packages/executor-sdk');
// Canonical starter `.kortix/opencode` surface (pty plugin + standard tools +
// skills). Staged into the context so the layer can warm a real opencode project
// instance at build time (see dockerfile-layer.ts `opencodeConfigPath`).
const opencodeConfigSrcPath = () => process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH
  || resolve(REPO_ROOT, 'packages/starter/templates/base/.kortix/opencode');
const opencodeWarmupSrcPath = () => process.env.KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/opencode-warmup.sh');
const machineDocSrcPath = () => process.env.KORTIX_SNAPSHOT_MACHINE_DOC_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/MACHINE.md');

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Default resource spec, shared by every provider when a template omits one. */
export const DEFAULT_CPU = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_CPU', 2);
export const DEFAULT_MEMORY_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_MEMORY_GB', 6);
export const DEFAULT_DISK_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_DISK_GB', 20);

/** The entrypoint baked into every snapshot (provider default). */
export const KORTIX_ENTRYPOINT = '/usr/local/bin/kortix-entrypoint';

export interface StagedContext {
  /** Temp dir holding the composed Dockerfile + staged artifacts. Caller removes it. */
  contextDir: string;
  /** Absolute path to the composed Dockerfile inside contextDir. */
  composedPath: string;
  /** Basename of the Dockerfile (for `-f`). */
  dockerfileName: string;
}

/**
 * Per-project COLD warm: bake the project's repo checkout into /workspace at
 * build time. The credential-bearing clone happens API-side in Suna
 * (`stageWarmRepoCheckout`), NOT inside the built image: the resulting build
 * context carries only a sanitized, origin-reset, credential-scrubbed checkout
 * that the Dockerfile `COPY`s. Omit for the shared, project-independent default
 * image.
 *
 * SECURITY (PHASE 1): `cloneHeaders` NEVER leaves this process. It is used to
 * clone (git config passed via ENV, never argv, never persisted to
 * `.git/config`), and the staged bytes are verified free of auth material
 * before they enter the build context — so no git credential reaches the
 * uploaded context, the OCI image history, the provider build logs, or an
 * abandoned retry object.
 */
export interface WarmRepoContext {
  /** Upstream URL to clone from at BUILD time (real git host or proxy). */
  cloneUrl: string;
  /** Auth headers for the API-side clone. Never embedded in any artifact. */
  cloneHeaders: Record<string, string>;
  /** Branch the tip belongs to — the fallback fetch ref for git hosts that
   *  reject fetch-by-sha, and validated as a defense-in-depth safe ref name. */
  branch: string;
  /**
   * The EXACT commit sha the checkout is pinned to. The warm image name is keyed
   * on this sha (`perProjectWarmImageName(..., tip, ...)`), so the staged checkout
   * MUST be this exact commit — cloning the branch tip (which can advance after
   * the sha was resolved) would bake SHA_Y content under a SHA_X name, poisoning
   * the content-addressed image. A full 40-char hex sha.
   */
  tip: string;
  /** Proxy origin the baked checkout's `origin` resets to (runtime re-auth). */
  originUrl: string;
}

/**
 * ─── CREDENTIAL ROTATION REQUIREMENT (PHASE 1 finding) ───────────────────────
 * Builds produced BEFORE this fix embedded the git-host clone credential
 * (`Authorization: <PAT/installation token>`) inside a Dockerfile `RUN`, which
 * shipped into: (1) the tar build context uploaded to object storage, (2) the
 * built image's OCI layer history, (3) the provider build logs, and (4) any
 * abandoned retry/context objects. Deleting the temp clone dir did NOT remove
 * any of those copies. Therefore, on rollout, ANY git credential that could
 * have been used for a per-project warm bake before this change must be treated
 * as POTENTIALLY EXPOSED and ROTATED:
 *   • GitHub App INSTALLATION tokens are short-lived (~1h) → low residual risk,
 *     but any long-lived fallback PAT must be rotated.
 *   • Any project-level BYO git PAT/credential stored + used for a warm bake
 *     must be rotated and the old value revoked at the git host.
 *   • Object-storage build-context objects created by prior builds should be
 *     lifecycle-expired/deleted (see the tracking + cleanup follow-up).
 * After this change no NEW build can leak a credential (proven by
 * warm-repo-credential.test.ts + the shared layer-render tests), so rotation is
 * a one-time remediation of the pre-fix window, not an ongoing requirement.
 */

/** Basename (in the build context) of the staged credential-free checkout. */
export const WARM_REPO_STAGED_DIR = 'kortix-warm-repo';
/**
 * Visible tar archive of `.git`.
 *
 * Daytona uploads each Dockerfile COPY source as a separate context object.
 * A directory COPY into `/workspace/.git` can complete without restoring a
 * usable repository. A single visible file crosses that boundary unchanged.
 */
export const WARM_REPO_STAGED_GIT_ARCHIVE = 'kortix-warm-repo-git.tar';

/**
 * A conservative safe-subset of git branch/ref names: letters, digits, and
 * `._/-`, no leading `-` or `/`, no `..`, bounded length. This rejects every
 * shell metacharacter (space, `;` `"` `` ` `` `$` `|` `&` `\n` …) so a hostile
 * `default_branch` can never inject a build-time or clone-time shell command —
 * defense-in-depth on top of the render's shell-quoting + the clone's argv
 * (non-shell) invocation. Deliberately stricter than `git check-ref-format`
 * (which permits some of these) because a warm-repo branch is a plain tip name.
 */
export function isSafeGitBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.includes('..') || branch.includes('//')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch);
}

/**
 * A full 40-char lowercase hex commit sha — the ONLY shape the warm-repo pin
 * accepts. `resolveCommitSha` already guarantees this upstream; re-checking here
 * is defense-in-depth so a malformed/attacker-influenced value can never reach a
 * `git fetch <sha>` argument (which, while argv not shell, must still be a plain
 * object name — never a ref-spec, option, or path).
 */
export function isSafeGitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

/**
 * Assert a warm-repo `cloneUrl` is safe to hand to `git clone`. Git's remote
 * layer treats a cloneUrl like `ext::sh -c '…'`, `file::…`, or `fd::…` as a
 * REMOTE-HELPER invocation, and a `scheme://user:token@host` URL leaks the
 * credential into FETCH_HEAD / reflog — so an attacker-influenced cloneUrl is a
 * build-time RCE / local-file-exfiltration / secret-leak surface. We pin the
 * transport to plain `https://` with NO userinfo. `file://` is permitted ONLY
 * under the test harness (NODE_ENV==='test') for the no-network fixture clones —
 * production warm cloneUrls are always the project's https upstream.
 *
 * Throws a CREDENTIAL-FREE error (scheme only, never the full URL/query) so a
 * rejection never logs a token.
 */
export function assertSafeCloneUrl(cloneUrl: string): void {
  let u: URL;
  try {
    u = new URL(cloneUrl);
  } catch {
    throw new Error('refusing to clone warm repo: cloneUrl is not a valid absolute URL');
  }
  const testFileClone =
    process.env.NODE_ENV === 'test' && u.protocol === 'file:' && cloneUrl.startsWith('file://');
  if (u.protocol !== 'https:' && !testFileClone) {
    throw new Error(
      `refusing to clone warm repo: cloneUrl must use https (rejected scheme "${u.protocol}") — ` +
        `git remote-helper transports (ext::/file::/fd::) are not allowed`,
    );
  }
  if (u.username || u.password) {
    throw new Error('refusing to clone warm repo: cloneUrl must not embed userinfo (user:pass@host)');
  }
}

/**
 * Per-clone protocol allow-list, passed as `git -c` config so it is scoped to
 * THIS clone (not global). Denies every transport by default, then re-enables
 * ONLY the one scheme the (already-validated) cloneUrl uses — belt-and-braces
 * with GIT_ALLOW_PROTOCOL so an unexpected redirect/submodule can't switch to a
 * remote-helper protocol mid-clone. Exported for the regression test that
 * asserts the pin is present in the clone invocation.
 */
export function warmCloneProtocolPinArgs(cloneUrl: string): string[] {
  const scheme = new URL(cloneUrl).protocol.replace(/:$/, '');
  return ['-c', 'protocol.allow=never', '-c', `protocol.${scheme}.allow=always`];
}

/**
 * Clone `warmRepo` API-side into the build context as a SANITIZED,
 * credential-free checkout the Dockerfile can `COPY` into /workspace. This is
 * the PHASE 1 fix for the credential leak: the git auth header is used ONLY
 * here (on the Suna host), passed to git via config-in-ENV so it never lands in
 * process argv or `.git/config`, and the resulting bytes are verified to
 * contain no auth material before they enter the (uploadable) build context.
 *
 *   1. init an empty repo and fetch the EXACT pinned sha (`warmRepo.tip`) with the
 *      credential (env config, depth 1) — NEVER a branch clone, whose tip could
 *      have advanced past the sha the image name is keyed on (SHA_X name ⇒ SHA_Y
 *      content is a poisoned/wasted warm image). Falls back to a shallow branch
 *      fetch + `checkout <tip>` for hosts that reject fetch-by-sha, and FAILS the
 *      bake if the sha is gone (force-pushed away) rather than ship other content,
 *   2. reset `origin` to the runtime proxy so the daemon re-auths per session,
 *   3. drop any credential helper / http.extraHeader that could have persisted,
 *   4. ASSERT the baked HEAD equals the pinned tip (belt-and-braces),
 *   5. ASSERT `.git/config` carries no `authorization`/`http.extraheader`/
 *      embedded userinfo before returning.
 *
 * Returns the staged dir basename + the exact baked HEAD sha (for the caller's
 * verification / logging). Throws if the checkout still contains credentials —
 * failing the build closed is correct; shipping a leaked token is not.
 */
export async function stageWarmRepoCheckout(
  contextDir: string,
  warmRepo: WarmRepoContext,
): Promise<{ stagedPath: string; stagedGitPath: string; headSha: string }> {
  if (!isSafeGitBranchName(warmRepo.branch)) {
    throw new Error(
      `refusing to bake per-project warm image: unsafe default branch name ${JSON.stringify(warmRepo.branch)}`,
    );
  }
  if (!isSafeGitSha(warmRepo.tip)) {
    throw new Error(
      `refusing to bake per-project warm image: pinned tip ${JSON.stringify(warmRepo.tip)} is not a full commit sha`,
    );
  }
  // Pin the clone transport BEFORE any git runs — reject remote-helper / userinfo
  // cloneUrls (build-time RCE / secret-leak surface) up front.
  assertSafeCloneUrl(warmRepo.cloneUrl);
  const dest = join(contextDir, WARM_REPO_STAGED_DIR);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  // git config via ENV (GIT_CONFIG_COUNT/KEY_i/VALUE_i) — NOT argv, NOT
  // persisted. http.extraHeader is multi-valued, so repeated keys accumulate.
  const headers = Object.entries(warmRepo.cloneHeaders ?? {});
  const headerEnv: Record<string, string> = { GIT_CONFIG_COUNT: String(headers.length) };
  headers.forEach(([k, v], i) => {
    headerEnv[`GIT_CONFIG_KEY_${i}`] = 'http.extraHeader';
    headerEnv[`GIT_CONFIG_VALUE_${i}`] = `${k}: ${v}`;
  });
  const cloneScheme = new URL(warmRepo.cloneUrl).protocol.replace(/:$/, '');
  const cloneEnv = {
    ...process.env,
    ...headerEnv,
    GIT_TERMINAL_PROMPT: '0',
    // Refuse to fall back to any interactive/stored credential helper — the
    // ENV header is the ONLY credential this clone may use.
    GIT_CONFIG_NOSYSTEM: '1',
    // Transport allow-list: only the validated cloneUrl scheme may run (blocks
    // ext::/file::/fd:: remote helpers even if git is coerced into one).
    GIT_ALLOW_PROTOCOL: cloneScheme,
  };
  const plainEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const g = (args: string[], env: NodeJS.ProcessEnv) =>
    execFileAsyncBC('git', args, { env, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });

  // Init an empty repo, then fetch the EXACT pinned sha (credentialed, protocol-
  // scoped). Cloning `--branch <branch>` would race a moved tip — the cloned HEAD
  // could advance past the sha the image name is keyed on — so we NEVER clone the
  // branch; we pin to the sha the cache key demands.
  await g(['-C', dest, 'init', '-q'], plainEnv);
  const protocolPin = warmCloneProtocolPinArgs(warmRepo.cloneUrl);
  try {
    // PRIMARY: fetch the exact commit. Works on git hosts that allow fetch-by-sha
    // (GitHub with allowReachableSHA1InWant, the local file transport, …) and is
    // immune to the branch advancing after the sha was resolved.
    await g(
      [...protocolPin, '-C', dest, 'fetch', '--depth', '1', warmRepo.cloneUrl, warmRepo.tip],
      cloneEnv,
    );
    await g(['-C', dest, 'checkout', '-q', 'FETCH_HEAD'], plainEnv);
  } catch {
    // FALLBACK for a host that refuses fetch-by-sha (allowReachableSHA1InWant off):
    // fetch the branch shallow, then check out the exact sha from it. If the sha is
    // no longer present (force-pushed away), FAIL the bake — the SHA-keyed content
    // no longer exists, and shipping other content under that name would poison the
    // content-addressed image.
    await g(
      [...protocolPin, '-C', dest, 'fetch', '--depth', '1', warmRepo.cloneUrl, warmRepo.branch],
      cloneEnv,
    );
    try {
      await g(['-C', dest, 'checkout', '-q', warmRepo.tip], plainEnv);
    } catch {
      throw new Error(
        `refusing to bake per-project warm image: pinned commit ${warmRepo.tip.slice(0, 12)} is not present ` +
          `on branch ${JSON.stringify(warmRepo.branch)} (force-pushed away?) — the SHA-keyed content no longer exists`,
      );
    }
  }
  // origin → runtime proxy (build credential is never persisted at runtime).
  // `git init` created no `origin`, so add it (fall back to set-url if present).
  await g(['-C', dest, 'remote', 'add', 'origin', warmRepo.originUrl], plainEnv).catch(() =>
    g(['-C', dest, 'remote', 'set-url', 'origin', warmRepo.originUrl], plainEnv),
  );
  // Belt + braces: drop anything credential-shaped that could have persisted.
  await g(['-C', dest, 'config', '--local', '--unset-all', 'http.extraHeader'], plainEnv).catch(() => {});
  await g(['-C', dest, 'config', '--local', '--unset-all', 'http.extraheader'], plainEnv).catch(() => {});
  await g(['-C', dest, 'config', '--local', '--unset-all', 'credential.helper'], plainEnv).catch(() => {});

  const { stdout: headOut } = await g(['-C', dest, 'rev-parse', 'HEAD'], plainEnv);
  const headSha = headOut.trim();

  // Belt-and-braces: the pinned checkout HEAD MUST equal the requested tip. Once
  // the checkout is pinned to the sha this can never fire — it is the last guard
  // ensuring a SHA_X-named warm image can never carry non-SHA_X content.
  if (headSha !== warmRepo.tip) {
    throw new Error(
      `warm-repo checkout HEAD ${headSha} does not match the pinned tip ${warmRepo.tip} — ` +
        `refusing to bake mismatched content under a SHA-keyed image name`,
    );
  }

  await assertCheckoutHasNoCredentials(dest);
  const stagedGit = join(contextDir, WARM_REPO_STAGED_GIT_ARCHIVE);
  await rm(stagedGit, { force: true });
  await execFileAsyncBC('tar', ['-cf', stagedGit, '-C', dest, '.git'], {
    env: plainEnv,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stagedPath: WARM_REPO_STAGED_DIR,
    stagedGitPath: WARM_REPO_STAGED_GIT_ARCHIVE,
    headSha,
  };
}

/**
 * Fail-closed guard: assert a staged warm-repo checkout carries no auth
 * material in its `.git/config` (no `authorization` header, no persisted
 * `http.extraheader`, no `credential.helper`, no `user:token@host` userinfo in
 * any remote URL). Exported for the regression test that renders with a
 * sentinel token and proves it never reaches the staged bytes.
 */
export async function assertCheckoutHasNoCredentials(checkoutDir: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const configPath = join(checkoutDir, '.git', 'config');
  let config = '';
  try {
    config = await readFile(configPath, 'utf8');
  } catch (err) {
    // A genuinely-absent .git/config (ENOENT) is the ONLY safe pass: there is
    // nothing credential-bearing to leak. ANY other read failure (EACCES from a
    // hostile mode, EISDIR from a config that's actually a directory, ELOOP from
    // a symlink loop, …) means we could NOT verify the checkout is clean — so we
    // must fail the build CLOSED rather than silently treat "couldn't read" as
    // "no credential". Swallowing every error here is how a leaked token ships.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
  const lower = config.toLowerCase();
  const offenders: string[] = [];
  if (lower.includes('authorization')) offenders.push('authorization header');
  if (lower.includes('extraheader')) offenders.push('http.extraheader');
  if (lower.includes('credential.helper') || lower.includes('[credential')) offenders.push('credential helper');
  // A remote URL of the form scheme://user:token@host embeds a secret.
  if (/url\s*=\s*[a-z]+:\/\/[^/\s]*:[^/@\s]+@/i.test(config)) offenders.push('embedded userinfo in remote url');
  if (offenders.length > 0) {
    throw new Error(
      `warm-repo checkout at ${checkoutDir} still contains credential material ` +
      `(${offenders.join(', ')}) — refusing to bake it into a build context`,
    );
  }
}

/**
 * Stage a build context for `snapshotName` from the user's Dockerfile. Returns
 * the temp dir + composed Dockerfile path. The CALLER is responsible for
 * removing contextDir when done.
 *
 * `isSharedDefault` is the caller's `BuildableTemplate.isShared` — it tells the
 * layer whether /workspace is the platform's to wipe after the opencode warm-up
 * or the user's to leave alone (see `KortixToolchainLayerOpts.isSharedDefault`).
 */
export async function stageBuildContext(
  snapshotName: string,
  userDockerfile: string,
  warmRepo?: WarmRepoContext,
  isSharedDefault?: boolean,
): Promise<StagedContext> {
  const AGENT_BIN_PATH = agentBinPath();
  const CLI_BIN_PATH = cliBinPath();
  const ENTRYPOINT_PATH = entrypointSrcPath();
  const SLACK_CLI_SRC_PATH = slackCliSrcPath();
  const EXECUTOR_SDK_SRC_PATH = executorSdkSrcPath();
  const OPENCODE_CONFIG_SRC_PATH = opencodeConfigSrcPath();
  const OPENCODE_WARMUP_SRC_PATH = opencodeWarmupSrcPath();
  const MACHINE_DOC_SRC_PATH = machineDocSrcPath();
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(CLI_BIN_PATH, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
  await assertExists(ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExistsDir(SLACK_CLI_SRC_PATH, 'KORTIX_SNAPSHOT_SLACK_CLI_PATH');
  await assertExistsDir(EXECUTOR_SDK_SRC_PATH, 'KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH');
  await assertExists(OPENCODE_WARMUP_SRC_PATH, 'KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH');
  await assertExists(MACHINE_DOC_SRC_PATH, 'KORTIX_SNAPSHOT_MACHINE_DOC_PATH');
  // Fingerprint/artifact skew guard: the snapshot identity hashes the agent
  // SOURCE (templates.ts AGENT_SRC_DIR), but the image bakes this prebuilt
  // dist binary — an edited src/ with a stale dist/ ships old code under a
  // NEW content hash, which is worse than failing (caught live 2026-06-10: a
  // daemon fix "rebuilt" into a fresh template whose forks still ran the old
  // binary). Refuse to stage a context whose binary predates the source.
  // Env-overridden binary paths skip this — the caller is pinning on purpose.
  if (!process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH) {
    const binMtime = (await stat(AGENT_BIN_PATH)).mtimeMs;
    const srcDir = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/src');
    const newestSrc = await newestMtimeMs(srcDir);
    if (newestSrc > binMtime) {
      throw new Error(
        `kortix-agent dist binary (${AGENT_BIN_PATH}) is older than its source ` +
        `(${srcDir}) — run \`bun run build\` in apps/kortix-sandbox-agent-server ` +
        `or the image will bake stale code under a fresh content hash`,
      );
    }
  }

  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-snap-'));
  await gzipFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent.gz'));
  await gzipFile(CLI_BIN_PATH, join(contextDir, 'kortix.gz'));
  await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));
  await copyFile(OPENCODE_WARMUP_SRC_PATH, join(contextDir, 'kortix-opencode-warmup'));
  await copyFile(MACHINE_DOC_SRC_PATH, join(contextDir, 'MACHINE.md'));
  await cp(SLACK_CLI_SRC_PATH, join(contextDir, 'kortix-slack-cli'), { recursive: true });
  // This package is copied as source and imported directly by the in-sandbox
  // channel CLIs. Its local node_modules is neither used nor portable: pnpm
  // represents entries as links into the checkout-wide store, and E2B hashes
  // every context entry before upload, so copying those links produces an
  // immediate ENOENT outside the original checkout. Keep the provider context
  // self-contained by staging source/package metadata only.
  await cp(EXECUTOR_SDK_SRC_PATH, join(contextDir, 'kortix-executor-sdk'), {
    recursive: true,
    filter: (source) => basename(source) !== 'node_modules',
  });
  // Stage the starter opencode config for the build-time instance warm-up.
  // Best effort: if it's missing, skip the warm-up (the build still succeeds and
  // sessions just pay the first-instance cost at runtime as before).
  let opencodeConfigPath: string | undefined;
  if (await isDir(OPENCODE_CONFIG_SRC_PATH)) {
    await cp(OPENCODE_CONFIG_SRC_PATH, join(contextDir, 'kortix-opencode-config'), {
      recursive: true,
    });
    opencodeConfigPath = 'kortix-opencode-config';
  }

  // PHASE 1: for a per-project COLD warm, clone the repo API-side into a
  // SANITIZED, credential-free checkout the Dockerfile only COPYs. The git auth
  // header is used here (Suna host) and NEVER embedded in the built image.
  let warmRepoBake: { stagedPath: string; stagedGitPath: string; branch: string } | undefined;
  if (warmRepo) {
    const { stagedPath, stagedGitPath } = await stageWarmRepoCheckout(contextDir, warmRepo);
    warmRepoBake = { stagedPath, stagedGitPath, branch: warmRepo.branch };
  }

  // Bake the FULL gateway model catalog into the image. The no-restart warm seed
  // has no sandbox token / projectId to fetch the catalog at PARK, so without this
  // its opencode picker would fall back to the daemon's minimal (~11) set. Computed
  // server-side at build time → full picker, no token, no runtime fetch. The shared
  // seed's captureEnv (builder.ts) points KORTIX_LLM_CATALOG_FILE at the COPY target.
  await writeFileFs(
    join(contextDir, 'kortix-llm-catalog.json'),
    JSON.stringify({ models: gatewayModelCatalog('shared-seed') }),
  );

  // Canonical scaffold repo baked at /opt/kortix/scaffold.git. Built from the
  // DEFAULT starter with the SAME pinned commit metadata the project seeder
  // uses (git-backends/seed.ts), so its root SHA equals every seeded project's
  // root — the daemon then materializes a project repo as local-clone +
  // delta-fetch instead of a full clone over the (slow) git path. Non-matching
  // repos (imported, other starters) share no ancestor and transparently fall
  // back to a full fetch through the same code.
  await stageScaffoldRepo(contextDir);

  const dockerfileName = '.kortix-snapshot.Dockerfile';
  const composedPath = join(contextDir, dockerfileName);
  const composed = buildLayeredDockerfile({
    userDockerfile,
    opencodeVersion: OPENCODE_VERSION,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
    agentBinaryPath: 'kortix-agent.gz',
    cliBinaryPath: 'kortix.gz',
    entrypointScriptPath: 'kortix-entrypoint',
    machineDocPath: 'MACHINE.md',
    slackCliPath: 'kortix-slack-cli',
    executorSdkPath: 'kortix-executor-sdk',
    opencodeConfigPath,
    opencodeWarmupScriptPath: 'kortix-opencode-warmup',
    catalogPath: 'kortix-llm-catalog.json',
    isSharedDefault,
    warmRepo: warmRepoBake,
  });

  await guardBuildahPortable(composed);
  await writeComposedDockerfile(composedPath, composed);
  // Fail-loud completeness guard: a context missing scaffold.git / the agent
  // binary / the composed Dockerfile reaches the provider as a confusing remote
  // "Path does not exist", and the auto-build can't tell it's a staging miss to
  // recover from. Assert at the source so a miss is caught here AND is retryable
  // (the daytona adapter re-stages on "staging incomplete").
  await assertContextComplete(contextDir, dockerfileName, warmRepoBake?.stagedPath);
  console.info(`[snapshots] ${snapshotName}: build context staged at ${contextDir}`);
  return { contextDir, composedPath, dockerfileName };
}

/**
 * Stage a MINIMAL build context for the per-project warm FAST PATH: a
 * Dockerfile that `FROM`s an already-built runtime image (the shared default's
 * provider-reported image ref) and only adds the warm-repo clone + opencode
 * instance re-warm on top — see `buildPerProjectWarmFromBaseDockerfile`
 * (dockerfile-layer.ts) for why this is the actual fix for the Chromium
 * re-download bug: nothing here re-installs the toolchain, so there's no
 * Chromium download to lose a cache race on.
 *
 * Unlike `stageBuildContext`, this does NOT stage the agent/CLI binaries,
 * entrypoint, slack-cli, executor-sdk, catalog, or scaffold.git — none of the
 * artifact tail is re-COPY'd; it's inherited from `baseImageRef`. Only the
 * starter opencode config (if present) is staged, for the instance re-warm.
 *
 * The caller (daytona.ts) is responsible for verifying `baseImageRef` points
 * at an `active` snapshot before calling this — a `FROM` of a missing or
 * still-building image fails the build immediately.
 */
export async function stageWarmFromBaseContext(
  snapshotName: string,
  baseImageRef: string,
  warmRepo: WarmRepoContext,
): Promise<StagedContext> {
  const OPENCODE_CONFIG_SRC_PATH = opencodeConfigSrcPath();
  const OPENCODE_WARMUP_SRC_PATH = opencodeWarmupSrcPath();
  await assertExists(OPENCODE_WARMUP_SRC_PATH, 'KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH');
  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-snap-warm-'));
  await copyFile(OPENCODE_WARMUP_SRC_PATH, join(contextDir, 'kortix-opencode-warmup'));
  let opencodeConfigPath: string | undefined;
  if (await isDir(OPENCODE_CONFIG_SRC_PATH)) {
    await cp(OPENCODE_CONFIG_SRC_PATH, join(contextDir, 'kortix-opencode-config'), {
      recursive: true,
    });
    opencodeConfigPath = 'kortix-opencode-config';
  }

  // PHASE 1: sanitized, credential-free repo checkout — cloned API-side, only
  // COPY'd by the rendered Dockerfile (no git auth header in the image).
  const { stagedPath, stagedGitPath } = await stageWarmRepoCheckout(contextDir, warmRepo);

  const dockerfileName = '.kortix-snapshot.Dockerfile';
  const composedPath = join(contextDir, dockerfileName);
  const composed = buildPerProjectWarmFromBaseDockerfile({
    baseImageRef,
    warmRepo: { stagedPath, stagedGitPath, branch: warmRepo.branch },
    opencodeConfigPath,
    opencodeWarmupScriptPath: 'kortix-opencode-warmup',
  });

  await guardBuildahPortable(composed);
  await writeComposedDockerfile(composedPath, composed);
  try {
    await stat(composedPath);
  } catch {
    throw new Error(`build context staging incomplete: ${dockerfileName} missing in ${contextDir}`);
  }
  console.info(`[snapshots] ${snapshotName}: FROM-base warm context staged at ${contextDir} (base=${baseImageRef})`);
  return { contextDir, composedPath, dockerfileName };
}

// ── Buildah-portability guard ──────────────────────────────────────────────
// The SAME composed context ships to BOTH providers. Daytona builds with
// BuildKit (supports `# syntax=docker/dockerfile:1.7` + RUN heredocs); Platinum
// builds with podman/buildah's classic imagebuilder, which supports NEITHER — it
// parses a heredoc body's first line (e.g. `import importlib`) as a Dockerfile
// instruction and aborts EVERY build ("Unknown instruction: IMPORT"), failing
// all Platinum sessions. This exact regression (a `<<'PY'` python verify added
// 2026-06-27) took dev down for hours because Daytona silently tolerated it.
// Reject it at the SOURCE with a clear error instead of an opaque remote build
// failure minutes later — and keep the Dockerfile portable to both builders.
async function guardBuildahPortable(composed: string): Promise<void> {
  const heredocLine = composed
    .split('\n')
    .find((l) => !/^\s*#/.test(l) && /<<-?['"]?[A-Za-z_]\w*['"]?\s*\\?\s*$/.test(l));
  if (heredocLine) {
    throw new Error(
      `composed Dockerfile is not buildah-portable — it contains a RUN heredoc Platinum's ` +
        `builder cannot parse: "${heredocLine.trim().slice(0, 120)}". Use a single-line ` +
        `equivalent (e.g. \`python3 -c '...'\`). Heredocs and BuildKit-only \`# syntax\` ` +
        `directives work on Daytona but silently break every Platinum template build.`,
    );
  }
}

async function writeComposedDockerfile(composedPath: string, composed: string): Promise<void> {
  if (typeof (globalThis as any).Bun?.write === 'function') {
    await (globalThis as any).Bun.write(composedPath, composed);
  } else {
    const fs = await import('node:fs/promises');
    await fs.writeFile(composedPath, composed);
  }
}

/**
 * Verify the staged context contains the load-bearing files the composed
 * Dockerfile COPYs, so a staging miss fails HERE (clear + retryable) instead of
 * as an opaque provider "Path does not exist" mid-build. Cheap stat checks.
 */
async function assertContextComplete(
  contextDir: string,
  dockerfileName: string,
  warmRepoStagedPath?: string,
): Promise<void> {
  const required = [
    'scaffold.git',
    'kortix-agent.gz',
    'kortix-opencode-warmup',
    'MACHINE.md',
    dockerfileName,
  ];
  // A per-project warm bake COPYs the staged checkout — verify it (and its
  // baked .git) actually landed, so a staging miss fails HERE rather than as an
  // opaque remote "Path does not exist" mid-build.
  if (warmRepoStagedPath) {
    required.push(join(warmRepoStagedPath, '.git'));
    required.push(WARM_REPO_STAGED_GIT_ARCHIVE);
  }
  for (const rel of required) {
    try {
      await stat(join(contextDir, rel));
    } catch {
      throw new Error(`build context staging incomplete: ${rel} missing in ${contextDir}`);
    }
  }
}

async function newestMtimeMs(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const s = await stat(join(entry.parentPath ?? (entry as any).path ?? dir, entry.name)).catch(() => null);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}

async function assertExists(path: string, envVarHint: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error(`${envVarHint} must be an absolute path (got "${path}")`);
  }
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error(`${envVarHint} (${path}) is not a regular file`);
  } catch (err) {
    if (err instanceof Error && err.message.includes(envVarHint)) throw err;
    throw new Error(
      `Required artifact missing: ${path}. Set ${envVarHint} or run \`bun run build\` in apps/kortix-sandbox-agent-server.`,
    );
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function assertExistsDir(path: string, envVarHint: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error(`${envVarHint} must be an absolute path (got "${path}")`);
  }
  try {
    const s = await stat(path);
    if (!s.isDirectory()) throw new Error(`${envVarHint} (${path}) is not a directory`);
  } catch (err) {
    if (err instanceof Error && err.message.includes(envVarHint)) throw err;
    throw new Error(
      `Required directory missing: ${path}. Set ${envVarHint} or ship apps/sandbox/slack-cli.`,
    );
  }
}

async function gzipFile(sourcePath: string, targetPath: string): Promise<void> {
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(targetPath),
  );
}

/**
 * Gzip ONLY the kortix-agent binary to a temp .gz — for the Platinum agent-swap
 * fast path, which ships just the agent (not a whole build context) and has the
 * host debugfs-swap it into the predecessor's rootfs. Caller cleans up.
 */
export async function stageAgentBinaryGz(): Promise<{ gzPath: string; cleanup: () => Promise<void> }> {
  const AGENT_BIN_PATH = agentBinPath();
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  // Refuse an empty/truncated dist (e.g. an interrupted `bun build`) at the source.
  // The host re-validates (ELF/size + post-swap size match), but failing here keeps
  // a dead agent from ever being uploaded + swapped into a template.
  if ((await stat(AGENT_BIN_PATH)).size === 0) {
    throw new Error(`agent binary ${AGENT_BIN_PATH} is empty — refusing to stage for agent-swap`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'kortix-agent-swap-'));
  const gzPath = join(dir, 'kortix-agent.gz');
  await gzipFile(AGENT_BIN_PATH, gzPath);
  return { gzPath, cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); } };
}

async function stageScaffoldRepo(contextDir: string): Promise<void> {
  const work = join(contextDir, '.scaffold-work');
  await mkdir(work, { recursive: true });
  const files = buildStarterFiles({ projectName: 'kortix-project', repoFullName: 'kortix/kortix-project', template: DEFAULT_STARTER_TEMPLATE_ID });
  for (const f of files) {
    const full = join(work, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFileFs(full, f.content, 'utf8');
  }
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Kortix', GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix', GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const g = (args: string[], cwd: string) => execFileAsyncBC('git', args, { cwd, env, timeout: 60_000 });
  await g(['init', '-b', 'main'], work);
  await g(['config', 'user.name', 'Kortix'], work);
  await g(['config', 'user.email', 'noreply@kortix.ai'], work);
  await g(['add', '-A'], work);
  await g(['commit', '-m', 'chore: scaffold Kortix project'], work);
  await g(['clone', '--bare', '-q', work, join(contextDir, 'scaffold.git')], contextDir);
  await rm(work, { recursive: true, force: true });
}
