#!/usr/bin/env bun
/**
 * LOCAL COMPONENT microbenchmark: producing a usable working tree at commit X,
 * through the existing Git path versus an S3 repository snapshot, and gzip
 * versus Zstandard.
 *
 * WHAT THIS DOES NOT ESTABLISH
 * ----------------------------
 * It does not measure request-to-execution-ready for a real session, and it
 * therefore CANNOT decide the rollout gates. Both sides run against local
 * endpoints — a `file://` Git remote and a local S3 endpoint — so neither pays
 * a wide-area transfer, and the Git arm is a synthetic clone rather than the
 * daemon's full `materializeRepo` (no baked scaffold, no delta bundle, no
 * checkout reuse). Treat every number here as a component comparison on one
 * machine. The end-to-end figure comes from `bench-boot-attribution.ts` against
 * a real deployment, and nothing else.
 *
 * Arms (each produces a FRESH writable working tree, so the arms are comparable)
 *   git-cold        bare mirror clone + shallow checkout with the daemon's own
 *                   clone flags, nothing cached. The exact SHA is verified.
 *   git-warm        shallow checkout from an already-warm mirror. FAVOURABLE:
 *                   it does not count the mirror clone.
 *   snapshot-cold   S3 GET streamed into extraction with an empty local cache,
 *                   then copied out to a fresh writable tree.
 *   snapshot-warm   local snapshot cache hit, then copied out to a fresh
 *                   writable tree — the same deliverable as git-warm.
 *   prepare-miss    the WHOLE cost of an unprepared revision from a cold source:
 *                   acquire, build, publish, then materialize and activate.
 *
 * Download and extraction OVERLAP in the snapshot arms. Their durations are
 * never added together and presented as a saving.
 *
 * Usage:
 *   cd apps/api
 *   KORTIX_REPO_SNAPSHOT_ENDPOINT=http://127.0.0.1:19000 \
 *   KORTIX_REPO_SNAPSHOT_BUCKET=kortix-repo-snapshots \
 *   KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID=… KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY=… \
 *   bun run scripts/bench-repo-snapshot.ts \
 *     --repo small=/path/to/small --repo large=/path/to/large \
 *     --rounds 30 --warmups 2 --out bench/out
 *
 * Flags:
 *   --repo <label>=<path>   a local Git repository to benchmark (repeatable)
 *   --rounds <n>            measured rounds per cohort (default 30)
 *   --warmups <n>           discarded rounds per cohort (default 2)
 *   --codec <gzip|zstd|both>  default both
 *   --arms <a,b,…>          restrict the arms
 *   --out <dir>             write raw.json, results.csv and report.md here
 *   --concurrency <a,b,…>   also measure N simultaneous materializations of the
 *                           same revision (default 1,5,20; 0 disables)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoSnapshot, discardBuiltRepoSnapshot } from '../src/repo-snapshots/build';
import { normalizeRepoSnapshotIdentity } from '../src/repo-snapshots/format';
import { publishRepoSnapshot } from '../src/repo-snapshots/publish';
import { requireRepoSnapshotBucket } from '../src/repo-snapshots/s3';
import { materializeSnapshotLocally } from '../src/repo-snapshots/source-reader';
import type { RepoSnapshotRow } from '../src/repo-snapshots/store';

type Arm = 'git-cold' | 'git-warm' | 'snapshot-cold' | 'snapshot-warm' | 'prepare-miss';
const ALL_ARMS: Arm[] = ['git-cold', 'git-warm', 'snapshot-cold', 'snapshot-warm', 'prepare-miss'];

interface RepoTarget {
  label: string;
  path: string;
  sha: string;
  fileCount: number;
  contentBytes: number;
}

interface Sample {
  cohort: string;
  repo: string;
  codec: string;
  arm: Arm;
  round: number;
  wallMs: number;
  /**
   * CPU of THIS process only. The Git arms do their work in `git` child
   * processes whose CPU Node cannot attribute, so it is null for them rather
   * than a misleadingly small number.
   */
  cpuMs: number | null;
  /** RSS of the benchmark process after the arm. Not a per-arm peak. */
  rssMbAfter: number;
  /** Bytes actually transferred. Exact for snapshot arms; unknown for Git. */
  transferredBytes: number | null;
  /** Size of the produced working tree on disk (`du`). Not a network figure. */
  checkoutBytes: number;
  entryCount: number | null;
  error?: string;
}

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
}
function repeated(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1]!);
  return out;
}

const ROUNDS = Math.max(1, Number(flag('rounds', '30')));
const WARMUPS = Math.max(0, Number(flag('warmups', '2')));
const CODECS = (flag('codec', 'both') === 'both' ? ['gzip', 'zstd'] : [flag('codec', 'gzip')]) as Array<'gzip' | 'zstd'>;
const ARMS = (flag('arms', '') ? flag('arms', '').split(',') : ALL_ARMS) as Arm[];
const OUT = flag('out', '');
const CONCURRENCY = (flag('concurrency', '1,5,20') || '0')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const scratch = mkdtempSync(join(tmpdir(), 'kortix-bench-'));
process.env.KORTIX_GIT_CACHE_DIR = join(scratch, 'mirrors');
process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = join(scratch, 'snapshot-cache');

function git(cwd: string, ...rest: string[]): string {
  return execFileSync('git', rest, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function describeRepo(label: string, path: string): RepoTarget {
  const sha = git(path, 'rev-parse', 'HEAD');
  const files = git(path, 'ls-files').split('\n').filter(Boolean);
  // Sum the tracked blob sizes from `cat-file --batch-check`, which reads the
  // object store directly. The previous `ls-files | xargs wc -c` resolved paths
  // against the benchmark's own cwd rather than the repository and silently
  // reported 0 for every fixture.
  const sizes = execFileSync(
    'bash',
    [
      '-lc',
      `git -C ${JSON.stringify(path)} ls-tree -r -z --format='%(objectname)' HEAD | tr '\\0' '\\n' | ` +
        `git -C ${JSON.stringify(path)} cat-file --batch-check='%(objectsize)' | awk '{s+=$1} END {print s+0}'`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  const contentBytes = Number(sizes) || 0;
  if (contentBytes === 0 && files.length > 0) {
    throw new Error(`content size measurement failed for ${label}: ${files.length} files but 0 bytes`);
  }
  return { label, path, sha, fileCount: files.length, contentBytes };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; wallMs: number; cpuMs: number; rssMbAfter: number }> {
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const value = await fn();
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    value,
    wallMs,
    // Parent-process CPU. Callers that spawn `git` must discard this.
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssMbAfter: process.memoryUsage().rss / (1024 * 1024),
  };
}

function projectFor(target: RepoTarget) {
  return {
    projectId: `bench-${target.label}`,
    repoUrl: `file://${target.path}`,
    defaultBranch: git(target.path, 'rev-parse', '--abbrev-ref', 'HEAD'),
    manifestPath: 'kortix.yaml',
    // Non-null: keeps mirror access on the local path instead of a DB lookup.
    gitAuthToken: 'bench',
  };
}

/**
 * A shallow checkout at an exact SHA, using the flags the daemon's clone path
 * actually passes (`apps/kortix-sandbox-agent-server/src/git.ts`): depth 1,
 * single branch, no tags, blobless filter with a full-clone fallback for a
 * remote that does not advertise it.
 *
 * This is still SYNTHETIC: the daemon also has a baked scaffold, a delta bundle
 * and a warm-checkout reuse path that this arm does not model.
 */
async function gitCheckout(target: RepoTarget, mirror: string, into: string): Promise<number> {
  const branch = git(target.path, 'rev-parse', '--abbrev-ref', 'HEAD');
  const base = ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--branch', branch];
  try {
    execFileSync('git', [...base, '--filter=blob:none', `file://${mirror}`, into], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    rmSync(into, { recursive: true, force: true });
    execFileSync('git', [...base, `file://${mirror}`, into], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  const head = git(into, 'rev-parse', 'HEAD');
  if (head !== target.sha) throw new Error(`git arm produced ${head}, expected ${target.sha}`);
  return checkoutBytes(into);
}

function checkoutBytes(dir: string): number {
  return (
    Number(execFileSync('bash', ['-lc', `du -sk ${JSON.stringify(dir)} | cut -f1`], { encoding: 'utf8' }).trim()) * 1024
  );
}

/** Copy a cached snapshot into a FRESH writable tree — what a session receives. */
function activateCopy(from: string, into: string): number {
  execFileSync('bash', ['-lc', `mkdir -p ${JSON.stringify(into)} && cp -R ${JSON.stringify(from)}/. ${JSON.stringify(into)}/`], {
    encoding: 'utf8',
  });
  return checkoutBytes(into);
}

function freshMirror(target: RepoTarget): string {
  const mirror = join(scratch, 'mirrors', `${target.label}-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
  mkdirSync(join(scratch, 'mirrors'), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--bare', target.path, mirror], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return mirror;
}

interface Published {
  row: RepoSnapshotRow;
  key: string;
  compressedBytes: number;
  entryCount: number;
}

/** A ready ledger row for an already-published manifest. No database needed. */
function readyRowFor(
  identity: ReturnType<typeof normalizeRepoSnapshotIdentity>,
  manifest: { format: string; source: { tree_sha: string }; payload: { key: string; sha256: string; compressed_bytes: number; expanded_bytes: number; entry_count: number } },
  manifestKey: string,
  codec: 'gzip' | 'zstd',
): RepoSnapshotRow {
  return {
    snapshotId: `${identity.repositoryId}:${identity.commitSha}:${codec}`,
    provider: 'github',
    repositoryId: identity.repositoryId,
    owner: identity.owner,
    repo: identity.repo,
    commitSha: identity.commitSha,
    format: manifest.format,
    status: 'ready',
    manifestKey,
    payloadKey: manifest.payload.key,
    archiveSha256: manifest.payload.sha256,
    compression: codec,
    treeSha: manifest.source.tree_sha,
    compressedBytes: manifest.payload.compressed_bytes,
    expandedBytes: manifest.payload.expanded_bytes,
    entryCount: manifest.payload.entry_count,
  } as unknown as RepoSnapshotRow;
}

const publishedCache = new Map<string, Published>();
/** One shared warm mirror per repo — the git-warm arm's favourable baseline. */
const warmMirrors = new Map<string, string>();

async function ensurePublished(target: RepoTarget, codec: 'gzip' | 'zstd'): Promise<Published> {
  const cacheKey = `${target.label}:${codec}`;
  const hit = publishedCache.get(cacheKey);
  if (hit) return hit;
  const identity = normalizeRepoSnapshotIdentity({
    repositoryId: String(100000 + [...cacheKey].reduce((a, c) => a + c.charCodeAt(0), 0)),
    owner: 'kortix-bench',
    repo: target.label,
    commitSha: target.sha,
  });
  const built = await buildRepoSnapshot(projectFor(target), identity, { compression: codec });
  const published = await publishRepoSnapshot({
    bucket: requireRepoSnapshotBucket(),
    identity,
    manifest: built.manifest,
    archivePath: built.archivePath,
  });
  await discardBuiltRepoSnapshot(built);
  const row = readyRowFor(identity, published.manifest, published.manifestKey, codec);
  const value: Published = {
    row,
    key: published.manifest.payload.key,
    compressedBytes: published.manifest.payload.compressed_bytes,
    entryCount: published.manifest.payload.entry_count,
  };
  publishedCache.set(cacheKey, value);
  return value;
}

async function runArm(
  arm: Arm,
  target: RepoTarget,
  codec: 'gzip' | 'zstd',
): Promise<Omit<Sample, 'cohort' | 'repo' | 'codec' | 'arm' | 'round'>> {
  const work = join(scratch, 'work', `${arm}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(scratch, 'work'), { recursive: true });
  try {
    if (arm === 'git-cold') {
      const measured = await timed(async () => {
        const mirror = freshMirror(target);
        const bytes = await gitCheckout(target, mirror, work);
        rmSync(mirror, { recursive: true, force: true });
        return bytes;
      });
      return {
        wallMs: measured.wallMs,
        cpuMs: null,
        rssMbAfter: measured.rssMbAfter,
        transferredBytes: null,
        checkoutBytes: measured.value,
        entryCount: target.fileCount,
      };
    }
    if (arm === 'git-warm') {
      let mirror = warmMirrors.get(target.label);
      if (!mirror) {
        mirror = freshMirror(target);
        warmMirrors.set(target.label, mirror);
      }
      const measured = await timed(() => gitCheckout(target, mirror!, work));
      return {
        wallMs: measured.wallMs,
        cpuMs: null,
        rssMbAfter: measured.rssMbAfter,
        transferredBytes: null,
        checkoutBytes: measured.value,
        entryCount: target.fileCount,
      };
    }
    if (arm === 'snapshot-cold') {
      const published = await ensurePublished(target, codec);
      // Empty local cache forces the full S3 -> decompress -> extract path.
      rmSync(join(scratch, 'snapshot-cache'), { recursive: true, force: true });
      const measured = await timed(async () => {
        const cached = await materializeSnapshotLocally(published.row);
        // Same deliverable as the Git arms: a fresh writable working tree.
        return activateCopy(cached, work);
      });
      return {
        wallMs: measured.wallMs,
        cpuMs: measured.cpuMs,
        rssMbAfter: measured.rssMbAfter,
        transferredBytes: published.compressedBytes,
        checkoutBytes: measured.value,
        entryCount: published.entryCount,
      };
    }
    if (arm === 'snapshot-warm') {
      const published = await ensurePublished(target, codec);
      await materializeSnapshotLocally(published.row);
      const measured = await timed(async () => {
        const cached = await materializeSnapshotLocally(published.row);
        return activateCopy(cached, work);
      });
      return {
        wallMs: measured.wallMs,
        cpuMs: measured.cpuMs,
        rssMbAfter: measured.rssMbAfter,
        transferredBytes: 0,
        checkoutBytes: measured.value,
        entryCount: published.entryCount,
      };
    }
    // prepare-miss: the WHOLE cost of an unprepared revision from a COLD
    // source — acquire, build, publish, then materialize and activate. A miss
    // that stopped at "built" would understate what a waiting session pays.
    const missIdentity = normalizeRepoSnapshotIdentity({
      repositoryId: String(500000 + Math.floor(Math.random() * 400000)),
      owner: 'kortix-bench',
      repo: `${target.label}-miss`,
      commitSha: target.sha,
    });
    const measured = await timed(async () => {
      // Cold source: a mirror this arm creates and destroys, never a warm one.
      const mirrorRoot = join(scratch, 'mirrors', `miss-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      process.env.KORTIX_GIT_CACHE_DIR = mirrorRoot;
      try {
        const built = await buildRepoSnapshot(projectFor(target), missIdentity, { compression: codec });
        const published = await publishRepoSnapshot({
          bucket: requireRepoSnapshotBucket(),
          identity: missIdentity,
          manifest: built.manifest,
          archivePath: built.archivePath,
        });
        await discardBuiltRepoSnapshot(built);
        const row = readyRowFor(missIdentity, published.manifest, published.manifestKey, codec);
        const cached = await materializeSnapshotLocally(row);
        return {
          checkoutBytes: activateCopy(cached, work),
          transferredBytes: published.manifest.payload.compressed_bytes,
          entryCount: published.manifest.payload.entry_count,
        };
      } finally {
        process.env.KORTIX_GIT_CACHE_DIR = join(scratch, 'mirrors');
        rmSync(mirrorRoot, { recursive: true, force: true });
      }
    });
    return {
      wallMs: measured.wallMs,
      cpuMs: null,
      rssMbAfter: measured.rssMbAfter,
      transferredBytes: measured.value.transferredBytes,
      checkoutBytes: measured.value.checkoutBytes,
      entryCount: measured.value.entryCount,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function quantile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function summarize(samples: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (sample.error) continue;
    const key = `${sample.repo}|${sample.codec}|${sample.arm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sample);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [repo, codec, arm] = key.split('|');
    const wall = rows.map((r) => r.wallMs);
    const cpu = rows.map((r) => r.cpuMs).filter((v): v is number => v !== null);
    return {
      repo: repo!,
      codec: codec!,
      arm: arm! as Arm,
      n: rows.length,
      p50Ms: Math.round(quantile(wall, 50)),
      p90Ms: Math.round(quantile(wall, 90)),
      p95Ms: Math.round(quantile(wall, 95)),
      minMs: Math.round(Math.min(...wall)),
      maxMs: Math.round(Math.max(...wall)),
      // Interquartile range: the spread a reader needs to judge whether a
      // difference between two arms is meaningful at this sample size.
      iqrMs: Math.round(quantile(wall, 75) - quantile(wall, 25)),
      // Null for the arms whose work happens in `git` child processes.
      cpuMsP50: cpu.length === rows.length ? Math.round(quantile(cpu, 50)) : null,
      rssMbAfterP50: Math.round(quantile(rows.map((r) => r.rssMbAfter), 50)),
      transferredBytes: rows[0]!.transferredBytes,
      checkoutBytesP50: Math.round(quantile(rows.map((r) => r.checkoutBytes), 50)),
      entryCount: rows[0]!.entryCount,
    };
  });
}

async function main(): Promise<void> {
  const targets = repeated('repo').map((spec) => {
    const [label, path] = spec.split('=');
    if (!label || !path) throw new Error(`--repo expects <label>=<path>, got ${spec}`);
    return describeRepo(label, path);
  });
  if (!targets.length) {
    console.error('No --repo given. Example: --repo starter=packages/starter/templates/base');
    process.exit(2);
  }
  requireRepoSnapshotBucket();

  console.error(
    `bench: ${targets.length} repos x ${CODECS.join('/')} x ${ARMS.length} arms, ` +
      `${WARMUPS} warmup + ${ROUNDS} measured rounds`,
  );
  for (const t of targets) {
    console.error(`  ${t.label}: sha=${t.sha.slice(0, 10)} files=${t.fileCount} contentBytes=${t.contentBytes}`);
  }

  const samples: Sample[] = [];
  // Interleaved: every round runs every (repo, codec, arm) cell in a shuffled
  // order, so a machine that warms or throttles during the run affects all arms
  // alike instead of whichever one ran last.
  for (let round = 1 - WARMUPS; round <= ROUNDS; round++) {
    const cells: Array<{ target: RepoTarget; codec: 'gzip' | 'zstd'; arm: Arm }> = [];
    for (const target of targets) for (const codec of CODECS) for (const arm of ARMS) cells.push({ target, codec, arm });
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    }
    for (const cell of cells) {
      // Git arms are codec-independent; run them once per round, not per codec.
      if ((cell.arm === 'git-cold' || cell.arm === 'git-warm') && cell.codec !== CODECS[0]) continue;
      try {
        const measured = await runArm(cell.arm, cell.target, cell.codec);
        if (round > 0) {
          samples.push({
            cohort: `${cell.target.label}/${cell.codec}/${cell.arm}`,
            repo: cell.target.label,
            codec: cell.arm.startsWith('git') ? 'n/a' : cell.codec,
            arm: cell.arm,
            round,
            ...measured,
          });
        }
      } catch (error) {
        samples.push({
          cohort: `${cell.target.label}/${cell.codec}/${cell.arm}`,
          repo: cell.target.label,
          codec: cell.codec,
          arm: cell.arm,
          round,
          wallMs: Number.NaN,
          cpuMs: null,
          rssMbAfter: Number.NaN,
          transferredBytes: null,
          checkoutBytes: 0,
          entryCount: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (round > 0 && round % 5 === 0) console.error(`  round ${round}/${ROUNDS}`);
  }

  // ── Concurrency ─────────────────────────────────────────────────────────
  // Simultaneous starts on the SAME revision, which is the realistic shape: a
  // push lands and several sessions open on it at once. Measured as wall time
  // for the whole batch and per-materialization, with the local cache cleared
  // first so every worker races for the same cold object.
  const concurrency: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    for (const level of CONCURRENCY) {
      const codec = CODECS[0]!;
      const published = await ensurePublished(target, codec);
      rmSync(join(scratch, 'snapshot-cache'), { recursive: true, force: true });
      const batchRoot = join(scratch, 'work', `conc-${target.label}-${level}-${Date.now()}`);
      mkdirSync(batchRoot, { recursive: true });
      const started = performance.now();
      const results = await Promise.allSettled(
        Array.from({ length: level }, async (_unused, index) => {
          const cached = await materializeSnapshotLocally(published.row);
          return activateCopy(cached, join(batchRoot, `w${index}`));
        }),
      );
      const batchMs = performance.now() - started;
      const failed = results.filter((r) => r.status === 'rejected');
      concurrency.push({
        repo: target.label,
        codec,
        level,
        batchMs: Math.round(batchMs),
        perMaterializationMs: Math.round(batchMs / level),
        failed: failed.length,
        firstError:
          failed.length > 0 ? String((failed[0] as PromiseRejectedResult).reason).slice(0, 200) : null,
      });
      rmSync(batchRoot, { recursive: true, force: true });
    }
  }
  if (concurrency.length) {
    console.error('\nconcurrent materializations of one revision (cold local cache):');
    for (const row of concurrency) {
      console.error(
        `  ${String(row.repo).padEnd(12)} x${String(row.level).padStart(2)}  batch=${row.batchMs}ms  ` +
          `per-materialization=${row.perMaterializationMs}ms  failed=${row.failed}`,
      );
    }
  }

  const summary = summarize(samples);
  const env = {
    node: process.versions.node,
    bun: typeof Bun !== 'undefined' ? Bun.version : null,
    platform: `${process.platform}-${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    endpoint: process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT ?? '(aws)',
    startedAt: new Date().toISOString(),
  };

  const failures = samples.filter((s) => s.error);
  console.error('\nrepo             codec  arm             n    p50      p90      p95      IQR   xfer(KiB)');
  for (const row of summary.sort((a, b) => a.repo.localeCompare(b.repo) || a.arm.localeCompare(b.arm))) {
    const xfer = row.transferredBytes === null ? 'n/a' : String(Math.round(row.transferredBytes / 1024));
    console.error(
      `${row.repo.padEnd(16)} ${row.codec.padEnd(6)} ${row.arm.padEnd(15)} ${String(row.n).padStart(3)} ` +
        `${String(row.p50Ms).padStart(6)}ms ${String(row.p90Ms).padStart(6)}ms ${String(row.p95Ms).padStart(6)}ms ` +
        `${String(row.iqrMs).padStart(5)}ms ${xfer.padStart(9)}`,
    );
  }
  console.error(`\nerrors: ${failures.length}/${samples.length} samples`);
  for (const failure of failures.slice(0, 10)) {
    console.error(`  ${failure.cohort} r${failure.round}: ${failure.error}`);
  }

  // Ratio of this microbenchmark's two local arms. It is NOT the rollout gate:
  // the gate is defined on real project materialization inside a session, which
  // this script does not measure. Reported so the component difference is
  // visible and reproducible, and labelled so it cannot be mistaken for the gate.
  const gates: Array<Record<string, unknown>> = [];
  for (const repo of new Set(summary.map((s) => s.repo))) {
    const baseline = summary.find((s) => s.repo === repo && s.arm === 'git-cold');
    for (const codec of CODECS) {
      const candidate = summary.find((s) => s.repo === repo && s.arm === 'snapshot-cold' && s.codec === codec);
      if (!baseline || !candidate) continue;
      const reduction = (100 * (baseline.p50Ms - candidate.p50Ms)) / baseline.p50Ms;
      gates.push({
        repo,
        codec,
        baselineP50Ms: baseline.p50Ms,
        baselineIqrMs: baseline.iqrMs,
        snapshotP50Ms: candidate.p50Ms,
        snapshotIqrMs: candidate.iqrMs,
        n: Math.min(baseline.n, candidate.n),
        reductionPercent: Number(reduction.toFixed(1)),
        speedup: Number((baseline.p50Ms / candidate.p50Ms).toFixed(2)),
        // Deliberately NOT named "meetsGate": this script cannot evaluate the
        // rollout gate. See the module docblock.
        componentReductionAtLeast50Percent: reduction >= 50,
      });
    }
  }
  // Codec comparison: the decision input the brief requires before pinning a
  // codec. Size is what a WAN transfer pays for; time is what the CPU pays.
  const codecRows: Array<Record<string, unknown>> = [];
  for (const repo of new Set(summary.map((s) => s.repo))) {
    const gzip = summary.find((s) => s.repo === repo && s.arm === 'snapshot-cold' && s.codec === 'gzip');
    const zstd = summary.find((s) => s.repo === repo && s.arm === 'snapshot-cold' && s.codec === 'zstd');
    const gzipBuild = summary.find((s) => s.repo === repo && s.arm === 'prepare-miss' && s.codec === 'gzip');
    const zstdBuild = summary.find((s) => s.repo === repo && s.arm === 'prepare-miss' && s.codec === 'zstd');
    if (!gzip || !zstd) continue;
    const gzipBytes = gzip.transferredBytes;
    const zstdBytes = zstd.transferredBytes;
    codecRows.push({
      repo,
      gzipBytes,
      zstdBytes,
      // Null rather than NaN when either side is unknown: an unavailable metric
      // must read as unavailable, not as a number-shaped nothing.
      sizeDeltaPercent:
        gzipBytes && zstdBytes ? Number((100 * (zstdBytes - gzipBytes) / gzipBytes).toFixed(1)) : null,
      gzipReadP50Ms: gzip.p50Ms,
      zstdReadP50Ms: zstd.p50Ms,
      gzipBuildP50Ms: gzipBuild?.p50Ms ?? null,
      zstdBuildP50Ms: zstdBuild?.p50Ms ?? null,
    });
  }
  if (codecRows.length) {
    console.error('\ncodec — gzip vs zstd (negative size delta = zstd smaller):');
    for (const row of codecRows) {
      const kib = (value: unknown) => (typeof value === 'number' ? `${Math.round(value / 1024)}KiB` : 'n/a');
      const delta = row.sizeDeltaPercent === null ? 'n/a' : `${row.sizeDeltaPercent}%`;
      console.error(
        `  ${String(row.repo).padEnd(12)} gzip=${kib(row.gzipBytes)}/${row.gzipReadP50Ms}ms  ` +
          `zstd=${kib(row.zstdBytes)}/${row.zstdReadP50Ms}ms  size ${delta}`,
      );
    }
  }

  console.error('\ncomponent ratio — local synthetic Git clone vs local S3 snapshot:');
  console.error('  NOT the rollout gate. End-to-end session readiness is unmeasured here.');
  for (const gate of gates) {
    console.error(
      `  ${gate.repo}/${gate.codec}: ${gate.baselineP50Ms}ms (IQR ${gate.baselineIqrMs}) -> ` +
        `${gate.snapshotP50Ms}ms (IQR ${gate.snapshotIqrMs}), n=${gate.n} ` +
        `→ ${gate.reductionPercent}% / ${gate.speedup}x`,
    );
  }

  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, 'raw.json'),
      JSON.stringify(
        { env, targets, rounds: ROUNDS, warmups: WARMUPS, samples, summary, gates, codecRows, concurrency },
        null,
        2,
      ),
    );
    const csv = [
      'repo,codec,arm,round,wall_ms,cpu_ms,rss_mb_after,transferred_bytes,checkout_bytes,entry_count,error',
    ];
    for (const sample of samples) {
      csv.push(
        [
          sample.repo,
          sample.codec,
          sample.arm,
          sample.round,
          Number.isFinite(sample.wallMs) ? sample.wallMs.toFixed(3) : '',
          // Null for the arms whose work runs in `git` child processes.
          sample.cpuMs === null ? '' : sample.cpuMs.toFixed(3),
          Number.isFinite(sample.rssMbAfter) ? sample.rssMbAfter.toFixed(1) : '',
          sample.transferredBytes ?? '',
          sample.checkoutBytes,
          sample.entryCount ?? '',
          (sample.error ?? '').replace(/[,\n]/g, ' '),
        ].join(','),
      );
    }
    writeFileSync(join(OUT, 'results.csv'), `${csv.join('\n')}\n`);
    const md = [
      '# Repository snapshot materialization benchmark',
      '',
      `Environment: bun ${env.bun}, node ${env.node}, ${env.platform}, ${env.cpus} CPUs, endpoint ${env.endpoint}.`,
      `Rounds: ${WARMUPS} warmup + ${ROUNDS} measured per cohort, arms interleaved and shuffled each round.`,
      '',
      '| repo | sha | files | content bytes |',
      '| --- | --- | --- | --- |',
      ...targets.map((t) => `| ${t.label} | \`${t.sha.slice(0, 10)}\` | ${t.fileCount} | ${t.contentBytes} |`),
      '',
      '| repo | codec | arm | n | p50 ms | p90 ms | p95 ms | IQR ms | CPU p50 ms | transferred KiB | checkout KiB |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...summary.map(
        (r) =>
          `| ${r.repo} | ${r.codec} | ${r.arm} | ${r.n} | ${r.p50Ms} | ${r.p90Ms} | ${r.p95Ms} | ${r.iqrMs} | ` +
          `${r.cpuMsP50 ?? 'n/a (child process)'} | ${r.transferredBytes === null ? 'n/a' : Math.round(r.transferredBytes / 1024)} | ${Math.round(r.checkoutBytesP50 / 1024)} |`,
      ),
      '',
      `Sample errors: ${failures.length}/${samples.length}.`,
      '',
      '## Codec — gzip versus Zstandard',
      '',
      '| repo | gzip bytes | zstd bytes | size delta | gzip read p50 | zstd read p50 | gzip build p50 | zstd build p50 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...codecRows.map(
        (c) =>
          `| ${c.repo} | ${c.gzipBytes ?? 'n/a'} | ${c.zstdBytes ?? 'n/a'} | ` +
          `${c.sizeDeltaPercent === null ? 'n/a' : `${c.sizeDeltaPercent}%`} | ${c.gzipReadP50Ms} ms | ` +
          `${c.zstdReadP50Ms} ms | ${c.gzipBuildP50Ms ?? 'n/a'} ms | ${c.zstdBuildP50Ms ?? 'n/a'} ms |`,
      ),
      '',
      '## Component ratio — local synthetic Git clone versus local S3 snapshot',
      '',
      '**This is not the rollout gate.** The proposed gate is defined on project',
      'materialization inside a real session; this script measures neither a real',
      'session nor a wide-area transfer. The ratio below is a component',
      'measurement on one machine, reported so it is reproducible and so the',
      'difference it does show is visible.',
      '',
      '| repo | codec | baseline p50 (IQR) | snapshot p50 (IQR) | n | reduction | speedup |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...gates.map(
        (g) =>
          `| ${g.repo} | ${g.codec} | ${g.baselineP50Ms} ms (${g.baselineIqrMs}) | ${g.snapshotP50Ms} ms (${g.snapshotIqrMs}) | ${g.n} | ${g.reductionPercent}% | ${g.speedup}x |`,
      ),
      '',
      '## Concurrency — simultaneous materializations of one revision',
      '',
      '| repo | level | batch ms | per-materialization ms | failed |',
      '| --- | --- | --- | --- | --- |',
      ...concurrency.map(
        (c) => `| ${c.repo} | ${c.level} | ${c.batchMs} | ${c.perMaterializationMs} | ${c.failed} |`,
      ),
      '',
      '## Limits of this measurement',
      '',
      '- **Not the rollout gate.** Request-to-execution-ready is not measured.',
      '- **Both sides are local.** The Git arms read a `file://` mirror; the',
      '  snapshot arms read a local S3 endpoint. Neither pays a wide-area',
      '  transfer. No claim is made about how the gap changes in production —',
      '  the two arms would face different networks, and that is unmeasured.',
      '- **The Git arm is synthetic.** It is a clone with the daemon\'s flags at',
      '  the verified SHA. It does NOT model the daemon\'s baked scaffold, delta',
      '  bundle, or warm-checkout reuse, all of which make the real path faster',
      '  than this arm in the cases where they apply.',
      '- **`git-warm` excludes the mirror clone**, so it flatters the baseline.',
      '- **CPU is parent-process only.** The Git arms and `prepare-miss` do work',
      '  in `git` children whose CPU is not attributable here; those cells read',
      '  `n/a` rather than a misleadingly small number.',
      '- **RSS is the benchmark process after the arm**, not a per-arm peak.',
      '- **Transferred bytes are exact for snapshot arms only.** The Git arms',
      '  report the produced checkout size, which is not a network figure.',
      '- Download and extraction OVERLAP in the snapshot arms; their durations',
      '  are never summed and presented as a saving.',
      '- Every arm now produces the same deliverable: a fresh writable working',
      '  tree. `snapshot-warm` copies the cached tree out rather than reporting',
      '  a cache stat.',
      '',
    ].join('\n');
    writeFileSync(join(OUT, 'report.md'), md);
    console.error(`\nraw → ${join(OUT, 'raw.json')}\ncsv → ${join(OUT, 'results.csv')}\nreport → ${join(OUT, 'report.md')}`);
  }
  rmSync(scratch, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
