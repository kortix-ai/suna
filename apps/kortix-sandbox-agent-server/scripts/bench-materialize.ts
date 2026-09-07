#!/usr/bin/env bun
/**
 * Boot-latency benchmark for `materializeRepo` — the real function, across
 * every disk state a session can start from.
 *
 * Not a test (the behaviour is pinned by src/__tests__/materialize-reuse.test.ts).
 * This exists to answer "how much did that cost" with numbers, and to re-check
 * the answer after a change to the materialization tiers.
 *
 *   bun scripts/bench-materialize.ts
 *   bun scripts/bench-materialize.ts --runs=5 --behind=20
 *   BENCH_REPOS=/path/a.git,/path/b.git bun scripts/bench-materialize.ts
 *
 * Synthetic origins by default, so it runs anywhere. `BENCH_REPOS` points it at
 * real bare mirrors instead (`git clone --bare <url> <dir>`), which is the only
 * way to see how the tiers behave on real history and real tree sizes.
 *
 * ── THREE MEASUREMENT TRAPS, all three of which faked a result once ─────────
 *
 * 1. `git clone /abs/path` IGNORES `--depth` ("warning: --depth is ignored in
 *    local clones") and HARDLINKS the object database instead of transferring
 *    it. A ~1 GB repo "cloned" in 1.2 s and reported a 977 MiB depth-1 pack; the
 *    real depth-1 pack is 413 MiB. Every origin here is a `file://` URL.
 *
 * 2. `git reset --hard HEAD~N` does NOT delete objects, so a checkout staled
 *    that way still holds the tip and any reuse path trivially reports "already
 *    at tip, 0 bytes". Staleness is seeded as a real `--depth 1` clone of an
 *    older commit.
 *
 * 3. Attributing "bytes transferred" from the resulting object store bills the
 *    warm and reuse paths for objects that were already on disk. The tier is
 *    read from the daemon's own log lines and only a wipe is charged for its
 *    whole store.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { __setScaffoldRepoPathForTests, materializeRepo } from '../src/git'

const numArg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const RUNS = numArg('runs', 3)
const BEHIND = numArg('behind', 5)

const PINNED = {
  GIT_AUTHOR_NAME: 'Kortix',
  GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
  GIT_COMMITTER_NAME: 'Kortix',
  GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
}
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, env: { ...process.env, ...PINNED }, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
const gitQuiet = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, env: { ...process.env, ...PINNED }, stdio: 'ignore', maxBuffer: 1 << 26 })

function objectBytes(target: string): number {
  const dir = join(target, '.git', 'objects')
  if (!existsSync(dir)) return 0
  return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const mib = (b: number) => `${(b / 1048576).toFixed(1)}M`

const scratch = mkdtempSync(join(tmpdir(), 'kortix-bench-materialize-'))
const NO_SCAFFOLD = join(scratch, 'absent-scaffold.git')

/** Which tier ran — read from the daemon's own log lines, never assumed. */
const TIERS: [RegExp, string][] = [
  [/using baked repo checkout \(warm\)/, 'warm'],
  [/reusing the on-disk checkout/, 'REUSE-delta'],
  [/zero-network: baked scaffold/, 'scaffold-zero'],
  [/zero-network: API delta bundle/, 'scaffold-inline'],
  [/one request: remote API delta bundle/, 'scaffold-remote'],
  [/via scaffold delta-fetch/, 'scaffold-fetch'],
  [/\[git\] cloning repo/, 'WIPE+clone'],
]

interface Cell { ms: number; bytes: number; tier: string; fail?: string }

async function once(
  target: string, repoUrl: string, branch: string, tip: string, extraEnv: Record<string, string>,
): Promise<Cell> {
  const before = objectBytes(target)
  const hadCheckout = existsSync(join(target, '.git'))
  const lines: string[] = []
  const realWrite = process.stdout.write.bind(process.stdout)
  // @ts-expect-error deliberate stdout capture for tier attribution
  process.stdout.write = (chunk: unknown) => { lines.push(String(chunk)); return true }
  const t0 = performance.now()
  let fail: string | undefined
  try {
    await materializeRepo(loadConfig({
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_PROJECT_TARGET: target,
      KORTIX_WORKSPACE: target,
      KORTIX_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
      KORTIX_REPO_URL: repoUrl,
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_BRANCH_NAME: 'sess-1',
      KORTIX_SESSION_FRESH: '1',
      KORTIX_BASE_REF: branch,
      KORTIX_DEFAULT_BRANCH: branch,
      KORTIX_BASE_SHA: tip,
      ...extraEnv,
    }))
  } catch (err) {
    fail = err instanceof Error ? err.message.split('\n')[0].slice(0, 70) : String(err)
  }
  const ms = performance.now() - t0
  process.stdout.write = realWrite

  const log = lines.join('\n')
  let tier = 'unknown'
  for (const [re, name] of TIERS) if (re.test(log)) tier = name
  if (/reuse refused: origin/.test(log)) tier += '(refused:origin)'
  if (/failed its integrity probe/.test(log)) tier += '(refused:integrity)'

  // A fast failure and a fast success look identical in a timing column.
  try {
    if (git(target, 'rev-parse', 'HEAD') !== tip) fail ??= 'wrong HEAD'
    if (git(target, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'sess-1') fail ??= 'wrong branch'
    if (git(target, 'status', '--porcelain', '--untracked-files=no')) fail ??= 'dirty tree'
  } catch { fail ??= 'verification threw' }

  const after = objectBytes(target)
  const wiped = tier.includes('WIPE') || !hadCheckout
  return { ms, bytes: wiped ? after : Math.max(after - before, 0), tier, fail }
}

/** A shallow checkout of `sha`, presented as a prior boot would have left it. */
function seedStale(bare: string, target: string, sha: string, branch: string, originUrl: string) {
  const tmpRef = `bench-stale-${Math.random().toString(36).slice(2)}`
  gitQuiet(bare, 'branch', '-f', tmpRef, sha)
  try {
    gitQuiet(scratch, 'clone', '-q', '--depth', '1', '--single-branch', '--branch', tmpRef, `file://${bare}`, target)
    gitQuiet(target, 'branch', '-m', tmpRef, branch)
    gitQuiet(target, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    gitQuiet(target, 'update-ref', `refs/remotes/origin/${branch}`, sha)
    gitQuiet(target, 'update-ref', '-d', `refs/remotes/origin/${tmpRef}`)
    gitQuiet(target, 'remote', 'set-url', 'origin', originUrl)
  } finally {
    gitQuiet(bare, 'branch', '-D', tmpRef)
  }
}

async function scenario(
  label: string,
  seed: (target: string) => { repoUrl: string; branch: string; tip: string; scaffold: string; env?: Record<string, string> },
) {
  const cells: Cell[] = []
  for (let i = 0; i < RUNS; i += 1) {
    const target = join(scratch, `${label.replace(/\W/g, '')}-${i}`)
    mkdirSync(target, { recursive: true })
    const s = seed(target)
    __setScaffoldRepoPathForTests(s.scaffold)
    cells.push(await once(target, s.repoUrl, s.branch, s.tip, s.env ?? {}))
    rmSync(target, { recursive: true, force: true })
  }
  const ms = median(cells.map((c) => c.ms))
  const bytes = median(cells.map((c) => c.bytes))
  const fail = cells.find((c) => c.fail)?.fail
  console.log(
    `   ${label.padEnd(32)} ${ms.toFixed(0).padStart(7)}ms  ${mib(bytes).padStart(8)}` +
    `  [${cells[0]?.tier ?? '-'}]${fail ? `  FAIL ${fail}` : ''}`,
  )
}

/** Synthetic origin: `commits` commits, optional incompressible blob. */
function synthetic(commits: number, blobBytes = 0) {
  const root = join(scratch, `synth-${Math.random().toString(36).slice(2)}`)
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  gitQuiet(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'README.md'), 'generic scaffold\n')
  gitQuiet(src, 'add', '-A'); gitQuiet(src, 'commit', '-q', '-m', 'chore: scaffold Kortix project')
  const scaffoldSha = git(src, 'rev-parse', 'HEAD')
  const scaffoldBare = join(root, 'scaffold.git')
  gitQuiet(root, 'clone', '-q', '--bare', src, scaffoldBare)
  for (let i = 1; i <= commits; i += 1) {
    writeFileSync(join(src, `file-${i}.txt`), `change ${i}\n`)
    // randomBytes, not Buffer.alloc: zeros compress away and would keep the
    // bundle under the 24 KiB inline cap regardless of size.
    if (blobBytes && i === commits) writeFileSync(join(src, 'blob.bin'), randomBytes(blobBytes))
    gitQuiet(src, 'add', '-A'); gitQuiet(src, 'commit', '-q', '-m', `feat ${i}`)
  }
  const tip = git(src, 'rev-parse', 'main')
  const bundlePath = join(root, 'delta.bundle')
  gitQuiet(src, 'bundle', 'create', bundlePath, 'main', `^${scaffoldSha}`)
  const parentCommit = execFileSync('git', ['cat-file', 'commit', scaffoldSha], { cwd: src })
  const bare = join(root, 'origin.git')
  gitQuiet(root, 'clone', '-q', '--bare', src, bare)
  return {
    bare, scaffoldBare, scaffoldSha, tip,
    bundle64: readFileSync(bundlePath).toString('base64'),
    parent64: parentCommit.toString('base64'),
  }
}

console.log(`\nmaterializeRepo — ${RUNS} runs/scenario, medians, file:// origins`)
console.log(`stale checkout = shallow clone ${BEHIND} commits behind tip\n`)

const targets: { name: string; bare: string }[] = []
const fromEnv = (process.env.BENCH_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
for (const bare of fromEnv) {
  if (!existsSync(bare)) { console.log(`SKIP ${bare} — not found`); continue }
  let tip = ''
  // A still-cloning mirror ECHOES the literal "HEAD" rather than failing, so a
  // 40-hex check is the only safe guard against benchmarking a partial origin.
  try { tip = git(bare, 'rev-parse', 'HEAD') } catch { /* handled below */ }
  if (!/^[0-9a-f]{40}$/.test(tip)) { console.log(`SKIP ${bare} — HEAD did not resolve to a SHA`); continue }
  targets.push({ name: bare.split('/').pop() ?? bare, bare })
}
if (!targets.length) {
  const s = synthetic(60)
  targets.push({ name: 'synthetic (60 commits)', bare: s.bare })
}

for (const t of targets) {
  const branch = git(t.bare, 'symbolic-ref', '--short', 'HEAD')
  const commits = Number(git(t.bare, 'rev-list', '--count', branch))
  const tip = git(t.bare, 'rev-parse', branch)
  const back = Math.min(BEHIND, Math.max(commits - 1, 0))
  const stale = back > 0 ? git(t.bare, 'rev-parse', `${branch}~${back}`) : tip
  const url = `file://${t.bare}`
  console.log(`── ${t.name}  (${commits} commits, stale=${back} behind)`)
  await scenario('A empty workspace', () => ({ repoUrl: url, branch, tip, scaffold: NO_SCAFFOLD }))
  await scenario('B disk already at tip', (target) => {
    seedStale(t.bare, target, tip, branch, url)
    return { repoUrl: url, branch, tip, scaffold: NO_SCAFFOLD }
  })
  if (back > 0) {
    await scenario('C disk behind tip', (target) => {
      seedStale(t.bare, target, stale, branch, url)
      return { repoUrl: url, branch, tip, scaffold: NO_SCAFFOLD }
    })
  } else {
    console.log('   C disk behind tip                n/a — single-commit repo')
  }
  console.log('')
}

console.log('── scaffold tiers (root SHARED with the baked scaffold)')
for (const [label, blob] of [['D tiny delta (inline)', 0], ['E 8 MiB delta (over cap)', 8 * 1024 * 1024]] as const) {
  const s = synthetic(5, blob)
  const inlineFits = s.bundle64.length <= 24 * 1024
  await scenario(label, () => ({
    repoUrl: `file://${s.bare}`, branch: 'main', tip: s.tip, scaffold: s.scaffoldBare,
    env: {
      ...(inlineFits ? { KORTIX_GIT_DELTA_BUNDLE_BASE64: s.bundle64 } : {}),
      KORTIX_GIT_DELTA_PARENT_SHA: s.scaffoldSha,
      KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: s.parent64,
    },
  }))
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
