/**
 * Local config-provider bench: Git vs S3 acquisition of the same project, on
 * THIS machine, against a local API and its object store — no sandbox
 * provider, no tunnel. Every round is one materialize-once.ts child with the
 * environment a real fresh session gets (scaffold + remote delta bundle for
 * Git; pinned descriptor + presigned objects for S3), in a fresh workspace.
 *
 *   bun run scripts/config-provider-bench.ts \
 *     --api http://localhost:8008 --token-file ~/.kortix/pat \
 *     --project <id> --sha <tip> --parent-sha <scaffold root> \
 *     --parent-commit-base64 <hint.parent_commit_base64> \
 *     --pin <sha:treeSha256:treeBytes> --rounds 20 [--warmups 1] \
 *     [--arms git,prefer-s3] [--root /tmp/cpb] [--out results.jsonl]
 *
 * The scaffold (the image's /opt/kortix/scaffold.git) is rebuilt under --root
 * from the project's own root commit: a bare clone through the proxy, refs
 * reset to --parent-sha, everything else pruned. `--scaffold <path>` reuses
 * one. The API must presign for an endpoint this machine can reach
 * (KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT).
 *
 * Numbers are loopback-network numbers: they compare the two paths' intrinsic
 * cost (HTTP, extraction, git), not what a sandbox sees across a region.
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
function need(name: string): string {
  const v = arg(name)
  if (!v) {
    console.error(`--${name} is required`)
    process.exit(2)
  }
  return v
}

const api = (arg('api', 'http://localhost:8008') as string).replace(/\/$/, '')
const token = (await readFile(need('token-file'), 'utf8')).trim()
const project = need('project')
const sha = need('sha').toLowerCase()
const parentSha = need('parent-sha').toLowerCase()
// The API also ships the parent commit object (base64) so the daemon can
// verify/reconstruct the bundle's prerequisite; without it the bundle route
// is skipped ("incomplete or malformed parent commit payload") and the Git
// arm silently degrades to a proxied delta fetch — not the production route.
const parentCommitBase64 = arg('parent-commit-base64') ?? (arg('parent-commit-file') ? (await readFile(arg('parent-commit-file') as string, 'utf8')).trim() : undefined)
const pin = arg('pin')
// Like session create: fetch the descriptor once per round with the token and
// hand it to the daemon presigned, so its first attempt is one direct GET.
// `--no-env-descriptor` makes every round ask the proxy instead (the pre-#7221
// follow-up behaviour), for an A/B on the same objects.
const envDescriptorEnabled = !process.argv.includes('--no-env-descriptor')
const rounds = Number(arg('rounds', '10'))
const warmups = Number(arg('warmups', '1'))
const arms = (arg('arms', 'git,prefer-s3') as string).split(',').map((s) => s.trim()).filter(Boolean)
const root = resolve(arg('root', `/tmp/config-provider-bench-${Date.now().toString(36)}`) as string)
const out = arg('out')
const pkgDir = resolve(import.meta.dir, '..')
const repoUrl = `${api}/v1/git/${project}.git`

if (arms.some((a) => a !== 'git') && !pin) {
  console.error('--pin <sha:sha256:bytes> is required for an S3 arm (from `project-snapshot.ts status`)')
  process.exit(2)
}

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}
async function git(args: string[], cwd?: string): Promise<string> {
  const r = await run(['git', ...args], { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`)
  return r.stdout.trim()
}

// ── scaffold: the project's shared root commit, and nothing else ────────────
async function buildScaffold(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
  await git(['clone', '-q', '--bare', '-c', `http.extraHeader=Authorization: Bearer ${token}`, repoUrl, path])
  await git(['update-ref', 'refs/heads/main', parentSha], path)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], path)
  const refs = (await git(['for-each-ref', '--format=%(refname)'], path)).split('\n').filter((r) => r && r !== 'refs/heads/main')
  for (const ref of refs) await git(['update-ref', '-d', ref], path)
  await git(['config', '--unset-all', 'http.extraHeader'], path).catch(() => {})
  await git(['reflog', 'expire', '--expire=now', '--all'], path)
  await git(['gc', '-q', '--prune=now'], path)
  const head = await git(['rev-parse', 'HEAD'], path)
  if (head !== parentSha) throw new Error(`scaffold HEAD ${head} != parent ${parentSha}`)
  const objects = (await git(['count-objects', '-v'], path)).match(/in-pack: (\d+)/)?.[1] ?? '?'
  console.log(`[bench] scaffold ${path}: HEAD ${head.slice(0, 12)}, ${objects} objects`)
}

// ── one round = one child in a fresh workspace ──────────────────────────────
interface RoundResult {
  arm: string
  round: number
  ok: boolean
  provider?: string
  fallback?: unknown
  wall_acquire_ms?: number
  wall_total_ms?: number
  timings?: Record<string, number>
  s3_attempts?: number
  s3_extractor?: string | null
  s3_descriptor?: string | null
  hydration?: { status: string; ms: number; bytes: number } | null
  sha_matches?: boolean | null
  marks?: Record<string, number>
  git_path?: string
  error?: string
}

async function fetchDescriptorForEnv(): Promise<string | undefined> {
  const res = await fetch(`${repoUrl}/project-snapshot?sha=${sha}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    console.error(`[bench] descriptor HTTP ${res.status}; this round asks the proxy`)
    return undefined
  }
  return Buffer.from(await res.text()).toString('base64')
}

async function round(arm: string, n: number, scaffold: string): Promise<RoundResult> {
  const ws = join(root, `r${String(n).padStart(3, '0')}-${arm}`)
  await rm(ws, { recursive: true, force: true })
  await mkdir(ws, { recursive: true })
  const session = randomUUID()
  const descriptor = arm !== 'git' && envDescriptorEnabled ? await fetchDescriptorForEnv() : undefined
  const env: Record<string, string> = {
    KORTIX_WORKSPACE: ws,
    KORTIX_PROJECT_TARGET: ws,
    KORTIX_DEFAULT_BRANCH: 'main',
    KORTIX_REPO_URL: repoUrl,
    KORTIX_API_URL: api,
    KORTIX_TOKEN: token,
    KORTIX_PROJECT_ID: project,
    KORTIX_SESSION_ID: session,
    KORTIX_BRANCH_NAME: session,
    KORTIX_SESSION_FRESH: '1',
    KORTIX_BASE_SHA: sha,
    KORTIX_GIT_DELTA_BUNDLE_REMOTE: '1',
    KORTIX_GIT_DELTA_PARENT_SHA: parentSha,
    ...(parentCommitBase64 ? { KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: parentCommitBase64 } : {}),
    KORTIX_PROJECT_SNAPSHOT_MODE: arm,
    KORTIX_BENCH_SCAFFOLD_GIT: scaffold,
    ...(arm !== 'git' && pin ? { KORTIX_PROJECT_SNAPSHOT_PIN: pin } : {}),
    ...(descriptor ? { KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: descriptor } : {}),
  }
  const t0 = performance.now()
  const r = await run(['bun', 'run', 'scripts/materialize-once.ts'], { cwd: pkgDir, env })
  const wall = Math.round(performance.now() - t0)
  const lines = r.stdout.split('\n')
  const line = [...lines].reverse().find((l) => l.startsWith('BENCH_RESULT '))
  let parsed: any = null
  try {
    parsed = line ? JSON.parse(line.slice('BENCH_RESULT '.length)) : null
  } catch {}
  // Which Git route the daemon actually took (scaffold zero-network, scaffold
  // + API delta bundle, scaffold + remote bundle, or a full clone) — the
  // daemon logs exactly one "repo materialized …" / "cloning repo" line.
  const gitPath = lines
    .map((l) => {
      try {
        return JSON.parse(l)?.msg as string | undefined
      } catch {
        return undefined
      }
    })
    .find((m) => m && /repo materialized|cloning repo/.test(m))
    ?.replace(/^\[git\] /, '')
  // Warnings the daemon printed on the way (stderr): why a faster route was
  // skipped, e.g. the remote bundle GET failing.
  const notes = [...lines, ...r.stderr.split('\n')]
    .map((l) => {
      try {
        const o = JSON.parse(l)
        return o?.msg ? `${o.msg}${o.error ? `: ${String(o.error).slice(0, 160)}` : ''}${o.status ? ` (${o.status})` : ''}` : undefined
      } catch {
        return undefined
      }
    })
    .filter((m): m is string => !!m && /bundle|scaffold|clone|fetch/i.test(m))
  if (process.env.BENCH_NOTES === '1' && notes.length) console.log(`  notes: ${notes.join(' | ').slice(0, 600)}`)
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  if (!parsed || !parsed.ok) {
    return { arm, round: n, ok: false, wall_total_ms: wall, error: parsed?.error ?? `exit ${r.code}: ${r.stderr.trim().slice(-300)}` }
  }
  const summary = parsed.summary ?? {}
  return {
    arm,
    round: n,
    ok: true,
    provider: parsed.provider,
    fallback: parsed.fallback,
    wall_acquire_ms: parsed.wall_acquire_ms,
    wall_total_ms: parsed.wall_total_ms,
    timings: summary.timings ?? {},
    s3_attempts: summary.s3_attempts ?? 0,
    s3_extractor: summary.s3_extractor ?? null,
    s3_descriptor: summary.s3_descriptor ?? null,
    hydration: parsed.hydration,
    sha_matches: summary.sha_matches ?? null,
    marks: parsed.marks,
    git_path: gitPath,
  }
}

// ── report ──────────────────────────────────────────────────────────────────
function pct(values: number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.round(q * (v.length - 1)))] ?? null
}
function report(results: RoundResult[]): void {
  console.log('\narm          n   ok  fallbacks  acquire p50/p95 (ms)   stage timings p50 (ms)                    hydration ok  extractor')
  for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm && r.round > 0)
    const ok = rs.filter((r) => r.ok)
    const acq = ok.map((r) => r.wall_acquire_ms as number)
    const stages: Record<string, number[]> = {}
    for (const r of ok) for (const [k, v] of Object.entries(r.timings ?? {})) (stages[k] ??= []).push(v)
    const stageText = Object.entries(stages)
      .map(([k, v]) => `${k}=${pct(v, 0.5)}`)
      .join(' ')
    const hyd = ok.filter((r) => r.hydration?.status === 'ok').length
    const hydMs = pct(ok.map((r) => r.hydration?.ms ?? NaN), 0.5)
    const extractors = [...new Set(ok.map((r) => r.s3_extractor).filter(Boolean))].join(',') || '-'
    const descriptors = ok.filter((r) => r.s3_descriptor).map((r) => r.s3_descriptor)
    const descriptorText = descriptors.length ? ` descriptor: env ${descriptors.filter((d) => d === 'env').length}/${descriptors.length}` : ''
    const fallbacks = ok.filter((r) => r.fallback).length
    console.log(
      `${arm.padEnd(12)} ${String(rs.length).padStart(2)}  ${String(ok.length).padStart(3)}  ${String(fallbacks).padStart(9)}  ${String(pct(acq, 0.5)).padStart(6)} / ${String(pct(acq, 0.95)).padEnd(6)}   ${stageText.padEnd(42)}  ${arm === 'git' ? '-' : `${hyd}/${ok.length} (p50 ${hydMs} ms)`}  ${extractors}${descriptorText}`,
    )
  }
  const paths = new Map<string, number>()
  for (const r of results) if (r.ok && r.git_path) paths.set(`${r.arm}: ${r.git_path}`, (paths.get(`${r.arm}: ${r.git_path}`) ?? 0) + 1)
  if (paths.size) {
    console.log('\nGit routes taken (from the daemon log):')
    for (const [k, v] of paths) console.log(`  ${v}× ${k}`)
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.log(`\n${failed.length} failed round(s):`)
    for (const f of failed) console.log(`  ${f.arm} #${f.round}: ${f.error}`)
  }
}

// ── main ────────────────────────────────────────────────────────────────────
await mkdir(root, { recursive: true })
const scaffold = arg('scaffold') ?? join(root, 'scaffold.git')
if (!arg('scaffold')) await buildScaffold(scaffold)
console.log(`[bench] api=${api} project=${project} sha=${sha.slice(0, 12)} parent=${parentSha.slice(0, 12)} arms=${arms.join(',')} rounds=${rounds} warmups=${warmups} root=${root}`)

const results: RoundResult[] = []
const outFile = out ? Bun.file(out) : null
const writer = outFile ? outFile.writer() : null
for (let w = 1; w <= warmups; w += 1) {
  for (const arm of arms) {
    const r = await round(arm, -w, scaffold)
    console.log(`warmup ${arm}: ${r.ok ? `${r.provider} ${r.wall_acquire_ms} ms` : `FAILED ${r.error}`}`)
  }
}
for (let n = 1; n <= rounds; n += 1) {
  // Alternate the arm order every round so drift affects both equally.
  const order = n % 2 === 1 ? arms : [...arms].reverse()
  for (const arm of order) {
    const r = await round(arm, n, scaffold)
    results.push(r)
    writer?.write(`${JSON.stringify(r)}\n`)
    const t = r.timings ?? {}
    console.log(
      r.ok
        ? `round ${n} ${arm}: ${r.provider}${r.fallback ? ' (fallback)' : ''} acquire=${r.wall_acquire_ms}ms ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ')}${r.hydration ? ` hydration=${r.hydration.status}/${r.hydration.ms}ms` : ''}${r.s3_descriptor ? ` descriptor=${r.s3_descriptor}` : ''}${r.git_path ? ` route="${r.git_path}"` : ''}`
        : `round ${n} ${arm}: FAIL ${r.error}`,
    )
  }
}
writer?.end()
report(results)
