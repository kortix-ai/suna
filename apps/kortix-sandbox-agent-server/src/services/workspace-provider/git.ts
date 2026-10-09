/**
 * The git route: scaffold + delta fetch, the API's fast-boot bundle, or a
 * clone with retries, then the shared checkout finalization (checkout.ts).
 * Also the warm-pool seeds and the post-boot history backfill, which use the
 * same scaffold and clone.
 */
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Config } from '@/lib/config/config'
import { buildGitIdentityEnv, configureRepoGitIdentity, createStagePath, execGit, gitWithAuth, resolveCloneCredential } from '@/lib/git/git'
import { logger } from '@/lib/log/logger'
import { adoptOrClearBakedCheckout, checkoutLocalSessionBranch, checkoutSessionBranch, clearDirContents, isShallowRepo, markSessionCheckoutAdopted, requireRepoUrl, swapStageIntoTarget } from './checkout'

/**
 * Boot-local fallback for an empty/branchless upstream (a managed repo that was
 * provisioned but never seeded). Instead of failing the whole session on
 * "Remote branch <base> not found in upstream origin", lay down a fresh local
 * repo at `base` with one empty commit, so the session branch has a base to
 * fork from and OpenCode boots normally. The agent then populates the tree, and
 * the background remote-branch publish (createRemoteSessionBranch) / first push
 * seeds the upstream for real. A cold sandbox now boots exactly like a warm/
 * baked one — entirely from local git, never blocked on the remote.
 *
 * `dir` is the tmp clone target; the caller renames it into place afterwards.
 */
async function initLocalRepoAtBase(cfg: Config, dir: string, base: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await mkdir(dir, { recursive: true })
  const init = await execGit(['-C', dir, 'init'])
  if (init.code !== 0) throw new Error(`git init (empty upstream) failed: ${init.stderr}`)
  // Rename the unborn branch to `base` — version-robust vs `git init -b`, which
  // needs git ≥ 2.28.
  const branch = await execGit(['-C', dir, 'checkout', '-b', base])
  if (branch.code !== 0) throw new Error(`git checkout -b ${base} (empty upstream) failed: ${branch.stderr}`)
  if (cfg.repoUrl) {
    const addRemote = await execGit(['-C', dir, 'remote', 'add', 'origin', cfg.repoUrl])
    if (addRemote.code !== 0) throw new Error(`git remote add origin (empty upstream) failed: ${addRemote.stderr}`)
  }
  const commit = await execGit(
    ['-C', dir, 'commit', '--allow-empty', '-m', 'chore: initialize Kortix project'],
    { env: buildGitIdentityEnv(cfg) },
  )
  if (commit.code !== 0) throw new Error(`git initial commit (empty upstream) failed: ${commit.stderr}`)
  logger.info('[git] initialized fresh local repo at base (empty upstream)', { base, dir })
}

/**
 * Materialize the project repository into `cfg.projectTarget` at the configured
 * branch. Ported from core/scripts/kortix-daemon clone_project_if_requested.
 */
export async function materializeRepo(cfg: Config): Promise<void> {
  if (await adoptOrClearBakedCheckout(cfg)) return
  await acquireProjectViaGit(cfg)
}

/**
 * The acquisition half of the legacy Git path — scaffold delta or clone — followed by the shared checkout finalization (session
 * branch, identity, adoption marker). Expects an EMPTY target (see
 * adoptOrClearBakedCheckout). The workspace provider (acquire.ts) calls this as
 * the Git transport and as the fallback after a failed S3 attempt.
 */
export async function acquireProjectViaGit(cfg: Config): Promise<void> {
  const repoUrl = requireRepoUrl(cfg)
  const target = cfg.projectTarget
  const base = cfg.defaultBranch
  await mkdir(target, { recursive: true })
  {
    // Scaffold fast path: the image bakes the canonical starter repo at
    // /opt/kortix/scaffold.git whose root commit is SHARED with every project
    // seeded from the starter (deterministic root — comp git-backends/seed.ts).
    // A local clone is ~50ms and the follow-up fetch transfers only the
    // project's delta beyond that shared root (a fresh project = ~one tiny
    // commit) instead of the whole repo over the slow git path (9s through the
    // dev tunnel, 2026-06-13). Imported repos / other starters share no
    // ancestor → the fetch degrades to a full pack (same as a clone); ANY
    // failure falls through to the battle-tested clone path below.
    if (await tryScaffoldDeltaFetch(cfg, target, base)) {
      if (cfg.branchName) {
        // Fresh session → branch == base, create it LOCALLY (zero network).
        // Restart/resume → the remote branch may carry the agent's commits.
        if (cfg.sessionFresh) await checkoutLocalSessionBranch(target, cfg.branchName)
        else {
          await checkoutSessionBranch(
            cfg,
            target,
            cfg.branchName,
            await resolveCloneCredential(cfg),
          )
        }
      }
      await configureRepoGitIdentity(cfg, target)
      await markSessionCheckoutAdopted(target, cfg.branchName)
      return
    }
    const cloneCredential = await resolveCloneCredential(cfg)
    const tmpTarget = await createStagePath(target, 'clone')
    await rm(tmpTarget, { recursive: true, force: true })
    logger.info('[git] cloning repo', {
      repoUrl: repoUrl,
      base,
      target,
      depth: cfg.cloneDepth || 'full',
      filter: cfg.cloneFilter || 'none',
    })
    // Two failure modes on a restored microVM whose virtio-net RX intermittently
    // stalls during a large sustained transfer (worse when many sandboxes clone
    // at once):
    //   (a) the pack stream is RESET mid-flight → git exits non-zero with
    //       "early EOF" / "RPC failed" / "Connection reset" / "fetch-pack:
    //       unexpected disconnect" / "index-pack".
    //   (b) the stream STALLS with no reset → git has NO transfer timeout by
    //       default, so `git clone` blocks FOREVER (repo_ready never flips →
    //       the API's 75s runtime-ready timeout). This is the nastier one.
    // Fix BOTH: http.lowSpeedLimit/Time aborts a stalled transfer (<1 KB/s for
    // 12 s) so a hang becomes a fast failure, then we retry with jittered
    // backoff (jitter de-clusters concurrent retries so they don't re-stampede).
    // 4 attempts × (≤12 s stall-abort + backoff) stays well under the 75 s ceiling
    // while a transient blip clears in 1–2 retries. resolveCloneCredential already
    // retries the credential fetch; the clone itself needs it just as much.
    // `--depth` is the single biggest boot-latency lever: history is ~95% of the
    // transfer and 0% of what a fresh session's working tree needs. See
    // KORTIX_CLONE_DEPTH in config.ts for the measurements. A remote that can't
    // serve shallow degrades to a full clone on its own (the retry loop below
    // treats that like any other clone failure and retries unfiltered).
    const depthArgs = cfg.cloneDepth > 0 ? ['--depth', String(cfg.cloneDepth)] : []
    const baseCloneArgs = [
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'clone', '--branch', base, '--single-branch', ...depthArgs,
    ]
    const isTransientGit = (s: string) =>
      /early EOF|RPC failed|Connection reset|Recv failure|fetch-pack|unexpected disconnect|index-pack|Could not resolve host|Connection timed out|timed out|GnuTLS recv|SSL_read|TLS packet|Failed to connect|Empty reply|Operation too slow|transfer closed|server hung up|remote end hung up|Stream closed|HTTP 5/i.test(s)
    // The upstream has no base branch yet — a freshly provisioned managed repo
    // that was never seeded, or any empty repo. This is NOT a retryable failure:
    // cloning it 4× more just fails 4× identically. We boot from a fresh local
    // repo instead (see initLocalRepoAtBase below), so a cold sandbox starts
    // exactly like a warm/baked one — 100% from local git, never blocked on the
    // remote having `main`.
    const isEmptyUpstream = (s: string) =>
      /Remote branch .+ not found in upstream|Could not find remote branch|You appear to have cloned an empty repository|remote HEAD refers to nonexistent ref/i.test(s)
    const MAX_CLONE_ATTEMPTS = 4
    let cloned = { code: -1, stdout: '', stderr: '' } as Awaited<ReturnType<typeof gitWithAuth>>
    for (let attempt = 1; attempt <= MAX_CLONE_ATTEMPTS; attempt++) {
      await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
      // Blobless partial clone keeps full history but defers file blobs, cutting
      // the boot-time transfer from a full-history pack to roughly the working
      // tree. This is the dominant per-session boot cost on large repos.
      cloned = await gitWithAuth(cloneCredential, repoUrl, [
        ...baseCloneArgs,
        ...(cfg.cloneFilter ? [`--filter=${cfg.cloneFilter}`] : []),
        repoUrl,
        tmpTarget,
      ], { timeoutMs: 35_000 })
      if (cloned.code !== 0 && cfg.cloneFilter && !isTransientGit(cloned.stderr) && !isEmptyUpstream(cloned.stderr)) {
        // Remote may not advertise uploadpack.allowFilter — fall back to a full
        // clone so a non-supporting host still boots (just slower). Skip this for
        // an empty upstream: a full clone would fail identically (no base branch).
        logger.warn('[git] partial clone failed; retrying as a full clone', {
          stderr: cloned.stderr.slice(0, 200),
        })
        await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
        cloned = await gitWithAuth(cloneCredential, repoUrl, [...baseCloneArgs, repoUrl, tmpTarget], { timeoutMs: 35_000 })
      }
      if (cloned.code === 0) break
      // Empty upstream is terminal-but-fine: stop retrying and init locally below.
      if (isEmptyUpstream(cloned.stderr)) break
      const transient = isTransientGit(cloned.stderr)
      logger.warn('[git] clone attempt failed', { attempt, maxAttempts: MAX_CLONE_ATTEMPTS, transient, stderr: cloned.stderr.slice(0, 200) })
      if (!transient || attempt === MAX_CLONE_ATTEMPTS) break
      // Jittered backoff: base grows per attempt, jitter spreads concurrent retries.
      await new Promise((r) => setTimeout(r, 500 * attempt + Math.floor(Math.random() * 700)))
    }
    if (cloned.code !== 0) {
      if (isEmptyUpstream(cloned.stderr)) {
        // No base branch upstream → boot from a fresh local repo instead of
        // hard-failing the whole session. The agent's work + the background
        // remote-branch publish seed the upstream for real later.
        logger.warn('[git] base branch missing upstream (empty repo) — booting from a fresh local repo', {
          base,
          stderr: cloned.stderr.slice(0, 200),
        })
        await initLocalRepoAtBase(cfg, tmpTarget, base)
      } else {
        await rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
        throw new Error(`git clone failed after ${MAX_CLONE_ATTEMPTS} attempt(s): ${cloned.stderr}`)
      }
    }
    await swapStageIntoTarget(tmpTarget, target)
    // Fresh clone already left the working tree on `base` at tip — the old
    // extra `git fetch origin base` + `git reset --hard` here was a redundant
    // network round-trip on the per-session boot hot path. Removed.
  }

  if (cfg.branchName) {
    if (cfg.sessionFresh) {
      // Fresh session → branch == freshly-cloned base; local, no extra fetch.
      await checkoutLocalSessionBranch(target, cfg.branchName)
    } else {
      // resolveCloneCredential is memoized — this second call is now ~free.
      const cloneCredential = await resolveCloneCredential(cfg)
      await checkoutSessionBranch(cfg, target, cfg.branchName, cloneCredential)
    }
  }

  await configureRepoGitIdentity(cfg, target)
  await markSessionCheckoutAdopted(target, cfg.branchName)
}

/**
 * Restore full history AFTER boot, off the critical path.
 *
 * The boot clone is shallow (`--depth 1`) because history is ~95% of the
 * transfer and none of what a fresh working tree needs — but an agent that runs
 * `git log`, `git blame`, or `git diff <base>` later does need it. This fetches
 * the rest in the background once the session is already usable, so the shallow
 * clone is invisible to everything downstream.
 *
 * Deliberately fire-and-forget and fully best-effort: a session whose backfill
 * fails is still a working session (shallow), and blocking boot on it would
 * reintroduce the cost we just removed. Idempotent — a repo that is already
 * complete is skipped.
 */
export function scheduleHistoryBackfill(cfg: Config, target: string): void {
  void (async () => {
    try {
      if (!(await isShallowRepo(target))) return
      const started = Date.now()
      const credential = await resolveCloneCredential(cfg)
      const res = await gitWithAuth(credential, cfg.repoUrl, [
        '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
        '-C', target, 'fetch', '--unshallow', '--tags', 'origin',
      ], { timeoutMs: 300_000 })
      if (res.code !== 0) {
        logger.warn('[git] history backfill failed; repo stays shallow', {
          stderr: res.stderr.slice(0, 200),
        })
        return
      }
      logger.info('[git] history backfill complete', { ms: Date.now() - started })
    } catch (err) {
      logger.warn('[git] history backfill errored; repo stays shallow', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

const DEFAULT_SCAFFOLD_REPO_PATH = '/opt/kortix/scaffold.git'

let scaffoldRepoPath = DEFAULT_SCAFFOLD_REPO_PATH

export function __setScaffoldRepoPathForTests(path?: string): void {
  scaffoldRepoPath = path ?? DEFAULT_SCAFFOLD_REPO_PATH
}

/**
 * Seed-only: materialize the image-baked scaffold at `target` with ZERO network,
 * for the warm-snapshot builder. The seed has no project repo — it clones the
 * canonical scaffold so opencode can pay its per-directory project init (git
 * scan / file index / LSP / sqlite) ONCE, frozen into the snapshot. Every fresh
 * session shares the scaffold root, so a fork resumes with opencode already
 * 'ok' for /workspace (kills the runtime-ready wall). Returns true on success;
 * false (no scaffold baked) → caller leaves /workspace empty (degrades to the
 * old behaviour, never breaks). `base` is checked out as a local branch so the
 * working tree matches what a fresh session expects.
 */
export async function materializeScaffoldSeed(target: string, base: string): Promise<boolean> {
  if (!existsSync(scaffoldRepoPath)) return false
  const tmp = await createStagePath(target, 'seed')
  const t0 = Date.now()
  try {
    await rm(tmp, { recursive: true, force: true })
    const cloned = await execGit(['clone', '-q', scaffoldRepoPath, tmp])
    if (cloned.code !== 0) throw new Error(`seed scaffold clone: ${cloned.stderr}`)
    const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'HEAD'])
    if (co.code !== 0) throw new Error(`seed checkout base: ${co.stderr}`)
    await swapStageIntoTarget(tmp, target)
    logger.info('[git] seed scaffold materialized (zero-network)', { ms: Date.now() - t0, base })
    return true
  } catch (err) {
    logger.warn('[git] seed scaffold materialize failed; warm seed will boot repo-less', {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err),
    })
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

/**
 * Clone the PROJECT repo at base tip for a per-project warm seed (Platinum
 * stateful capture). Unlike materializeScaffoldSeed (the
 * repo-LESS generic scaffold), this clones the real project at base into
 * /workspace so the captured snapshot already has the repo — a fork then hits
 * materializeRepo's "using baked repo checkout (warm)" fast path (no in-box
 * clone). Leaves /workspace on `base` tip with NO session branch (none exists
 * during seed capture). Wipes any image-baked /workspace first so a scaffold is never mistaken
 * for the seed. Returns false (→ caller degrades to the scaffold seed) on any
 * failure, so a flaky clone never bricks the seed. Reuses materializeRepo's
 * battle-tested clone (retries, stall-abort, proxy auth) verbatim.
 */
export async function materializeProjectSeed(cfg: Config): Promise<boolean> {
  if (!cfg.repoUrl) return false
  const t0 = Date.now()
  try {
    await clearDirContents(cfg.projectTarget)
    // No branchName during seed capture (no session yet); baseSha=tip so a baked /workspace
    // (if any) is treated as mismatched and re-materialized to the real repo.
    await materializeRepo({ ...cfg, branchName: undefined, sessionFresh: true })
    logger.info('[git] project seed materialized at base', {
      ms: Date.now() - t0,
      base: cfg.defaultBranch,
    })
    return true
  } catch (err) {
    logger.warn('[git] project seed materialize failed; warm seed will fall back to scaffold', {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err),
    })
    return false
  }
}

// Materialize `target` from the image-baked scaffold + a delta fetch from the
// project origin. Returns true when target is ready on `base` tip; false →
// caller runs the normal network clone (never leaves a partial target behind).
async function tryScaffoldDeltaFetch(
  cfg: Config,
  target: string,
  base: string,
): Promise<boolean> {
  if (!existsSync(scaffoldRepoPath) || !cfg.repoUrl) return false
  const tmp = await createStagePath(target, 'scaffold')
  const t0 = Date.now()
  try {
    await rm(tmp, { recursive: true, force: true })
    const local = await execGit(['clone', '-q', scaffoldRepoPath, tmp])
    if (local.code !== 0) throw new Error(`local scaffold clone: ${local.stderr}`)
    const su = await execGit(['-C', tmp, 'remote', 'set-url', 'origin', cfg.repoUrl])
    if (su.code !== 0) throw new Error(`set-url: ${su.stderr}`)
    // ZERO-NETWORK fast path: the image-baked scaffold's root commit is shared,
    // byte-for-byte, with every project seeded from the starter. When the
    // project's base tip (resolved server-side, passed as KORTIX_BASE_SHA) IS
    // that root — a fresh project with no per-project commit — the local clone
    // already holds the exact base tree, so `git fetch` would transfer ZERO
    // objects: a pure negotiation round-trip that still hung ~34s through the
    // flaky dev tunnel (2026-06-13). Skip it: just branch off the local HEAD.
    const localHead = (await execGit(['-C', tmp, 'rev-parse', 'HEAD'])).stdout.trim()
    if (cfg.sessionFresh && cfg.baseSha && localHead === cfg.baseSha) {
      const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'HEAD'])
      if (co.code !== 0) throw new Error(`checkout base (local): ${co.stderr}`)
      await swapStageIntoTarget(tmp, target)
      logger.info('[git] repo materialized via scaffold (zero-network: baked scaffold == base tip)', { ms: Date.now() - t0, base, head: localHead })
      return true
    }
    if (
      cfg.sessionFresh &&
      cfg.baseSha &&
      cfg.gitDeltaBundleBase64 &&
      await applyFastBootDeltaBundle(
        tmp,
        base,
        cfg.baseSha,
        cfg.gitDeltaBundleBase64,
        cfg.gitDeltaParentSha,
        cfg.gitDeltaParentCommitBase64,
      )
    ) {
      await swapStageIntoTarget(tmp, target)
      logger.info('[git] repo materialized via scaffold (zero-network: API delta bundle)', {
        ms: Date.now() - t0,
        base,
        head: cfg.baseSha,
      })
      return true
    }
    // The delta exists but did not fit the env: ONE authenticated GET to the
    // API for the bundle `root..tip` (served from its mirror — no GitHub hop,
    // no pack negotiation) instead of a proxied `git fetch`.
    if (
      cfg.sessionFresh &&
      cfg.baseSha &&
      cfg.gitDeltaBundleRemote &&
      cfg.gitDeltaParentSha &&
      await applyRemoteFastBootDeltaBundle(cfg, tmp, base, cfg.baseSha, cfg.gitDeltaParentSha, cfg.gitDeltaParentCommitBase64)
    ) {
      await swapStageIntoTarget(tmp, target)
      logger.info('[git] repo materialized via scaffold (one request: remote API delta bundle)', {
        ms: Date.now() - t0,
        base,
        head: cfg.baseSha,
      })
      return true
    }
    const cloneCredential = await resolveCloneCredential(cfg)
    // Single round trip: `--depth 1` skips the have/want negotiation that a
    // plain fetch runs over the scaffold's loose objects (each round ~1 s
    // through the proxy; measured 4.1–6.5 s vs 3.6 s for a depth-1 clone,
    // 2026-08-27). The repo becomes shallow; scheduleHistoryBackfill restores
    // history off the critical path exactly as for a clone.
    const fetched = await gitWithAuth(cloneCredential, cfg.repoUrl, [
      '-C', tmp,
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=12',
      'fetch', '-q', '--depth', '1', '--no-tags', 'origin', base,
    ], { timeoutMs: 35_000 })
    if (fetched.code !== 0) throw new Error(`fetch: ${fetched.stderr}`)
    const co = await execGit(['-C', tmp, 'checkout', '-q', '-B', base, 'FETCH_HEAD'])
    if (co.code !== 0) throw new Error(`checkout base: ${co.stderr}`)
    await swapStageIntoTarget(tmp, target)
    logger.info('[git] repo materialized via scaffold delta-fetch', { ms: Date.now() - t0, base })
    return true
  } catch (err) {
    logger.info('[git] scaffold fast path unavailable; falling back to clone', {
      err: err instanceof Error ? err.message.slice(0, 200) : String(err),
    })
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

const MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES = 24 * 1024

/** Hard ceiling for a remote (downloaded) fast-boot bundle — mirrors the API's cap. */
const MAX_REMOTE_FAST_BOOT_BUNDLE_BYTES = 64 * 1024 * 1024

const REMOTE_FAST_BOOT_BUNDLE_TIMEOUT_MS = 30_000

/** Import a bounded API-generated Git bundle only when it resolves to baseSha. */
async function applyFastBootDeltaBundle(
  repoPath: string,
  base: string,
  baseSha: string,
  bundleBase64: string,
  parentSha?: string,
  parentCommitBase64?: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) return false
  if (
    bundleBase64.length === 0 ||
    bundleBase64.length > MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES ||
    bundleBase64.length + (parentCommitBase64?.length ?? 0) > MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES ||
    bundleBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(bundleBase64)
  ) return false
  const bytes = Buffer.from(bundleBase64, 'base64')
  if (bytes.toString('base64') !== bundleBase64) return false
  const bundlePath = join(repoPath, '.kortix-fast-boot.bundle')
  try {
    await writeFile(bundlePath, bytes, { mode: 0o600 })
    return await applyFastBootDeltaBundleFile(repoPath, base, baseSha, bundlePath, parentSha, parentCommitBase64)
  } catch (error) {
    logger.info('[git] API delta bundle unavailable; using authenticated fetch', {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
    return false
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {})
  }
}

/**
 * Build the URL of the API's `fast-boot-bundle` route from the proxied repo
 * URL (`…/v1/git/<project>.git`). Exported for tests.
 */
export function buildFastBootBundleUrl(repoUrl: string, ref: string, tip: string, parent: string): string {
  const url = new URL(repoUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/fast-boot-bundle`
  url.search = ''
  url.searchParams.set('ref', ref)
  url.searchParams.set('tip', tip)
  url.searchParams.set('parent', parent)
  return url.toString()
}

/**
 * Download the bundle `parent..tip` from the API with the sandbox token and
 * apply it on top of the baked scaffold. One request, bounded, verified by
 * `baseSha` before use; any failure → false → the caller's fetch fallback.
 */
async function applyRemoteFastBootDeltaBundle(
  cfg: Config,
  repoPath: string,
  base: string,
  baseSha: string,
  parentSha: string,
  parentCommitBase64: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.repoUrl || !cfg.sandboxToken) return false
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(parentSha)) return false
  const bundlePath = join(repoPath, '.kortix-fast-boot-remote.bundle')
  const started = Date.now()
  try {
    const res = await fetchImpl(buildFastBootBundleUrl(cfg.repoUrl, base, baseSha, parentSha), {
      headers: { accept: 'application/x-git-bundle', authorization: `Bearer ${cfg.sandboxToken}` },
      signal: AbortSignal.timeout(REMOTE_FAST_BOOT_BUNDLE_TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).trim().slice(0, 200)
      throw new Error(`fast-boot bundle HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_REMOTE_FAST_BOOT_BUNDLE_BYTES) {
      throw new Error(`fast-boot bundle exceeds ${MAX_REMOTE_FAST_BOOT_BUNDLE_BYTES} bytes (${declared})`)
    }
    if (!res.body) throw new Error('fast-boot bundle response body is empty')
    // Stream to the stage file under a hard byte cap — never buffer an
    // upstream body in memory, never trust its length header alone. The
    // bytes are then verified by `git bundle verify` + the baseSha check
    // before anything is checked out.
    let bytes = 0
    const capped = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_REMOTE_FAST_BOOT_BUNDLE_BYTES) {
          callback(new Error(`fast-boot bundle exceeds ${MAX_REMOTE_FAST_BOOT_BUNDLE_BYTES} bytes`))
          return
        }
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(res.body as never),
      capped,
      createWriteStream(bundlePath, { mode: 0o600 }),
    )
    if (bytes === 0) throw new Error('fast-boot bundle response body is empty')
    const ok = await applyFastBootDeltaBundleFile(repoPath, base, baseSha, bundlePath, parentSha, parentCommitBase64)
    if (ok) {
      logger.info('[git] remote fast-boot bundle applied', {
        bytes,
        ms: Date.now() - started,
        cache: res.headers.get('x-kortix-artifact-cache'),
      })
    }
    return ok
  } catch (error) {
    logger.info('[git] remote API delta bundle unavailable; using authenticated fetch', {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
    return false
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {})
  }
}

/**
 * Core of the delta import. The bundle's single prerequisite is `parentSha`
 * (the project's scaffold root). The baked scaffold either holds that commit
 * byte-for-byte, or only its TREE (a provider rewrote commit metadata) — in
 * which case the raw commit object shipped as `parentCommitBase64` is written
 * first so the prerequisite resolves. Every step verifies before it trusts.
 */
async function applyFastBootDeltaBundleFile(
  repoPath: string,
  base: string,
  baseSha: string,
  bundlePath: string,
  parentSha?: string,
  parentCommitBase64?: string,
): Promise<boolean> {
  const parentCommitPath = join(repoPath, '.kortix-fast-boot-parent.commit')
  try {
    if (parentSha || parentCommitBase64) {
      if (
        !parentSha ||
        !/^[0-9a-f]{40}$/i.test(parentSha) ||
        !parentCommitBase64 ||
        parentCommitBase64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(parentCommitBase64)
      ) {
        throw new Error('incomplete or malformed parent commit payload')
      }
      const parentBytes = Buffer.from(parentCommitBase64, 'base64')
      if (parentBytes.toString('base64') !== parentCommitBase64) {
        throw new Error('non-canonical parent commit payload')
      }
      await writeFile(parentCommitPath, parentBytes, { mode: 0o600 })
      const importedParent = await execGit([
        '-C', repoPath, 'hash-object', '-t', 'commit', '-w', parentCommitPath,
      ])
      if (importedParent.code !== 0 || importedParent.stdout.trim() !== parentSha) {
        throw new Error('parent commit payload does not match the expected SHA')
      }
      const parentTree = await execGit(['-C', repoPath, 'cat-file', '-e', `${parentSha}^{tree}`])
      if (parentTree.code !== 0) {
        throw new Error('parent commit tree is not present in the baked scaffold')
      }
    }
    const verified = await execGit(['-C', repoPath, 'bundle', 'verify', bundlePath])
    if (verified.code !== 0) throw new Error(`bundle verify: ${verified.stderr}`)
    const imported = await execGit(['-C', repoPath, 'bundle', 'unbundle', bundlePath])
    if (imported.code !== 0) throw new Error(`bundle unbundle: ${imported.stderr}`)
    const exists = await execGit(['-C', repoPath, 'cat-file', '-e', `${baseSha}^{commit}`])
    if (exists.code !== 0) throw new Error('bundle does not contain the expected base commit')
    const checkout = await execGit(['-C', repoPath, 'checkout', '-q', '-B', base, baseSha])
    if (checkout.code !== 0) throw new Error(`checkout bundled base: ${checkout.stderr}`)
    return true
  } catch (error) {
    logger.info('[git] API delta bundle unavailable; using authenticated fetch', {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
    return false
  } finally {
    await rm(parentCommitPath, { force: true }).catch(() => {})
  }
}
