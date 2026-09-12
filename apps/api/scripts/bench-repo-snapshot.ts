#!/usr/bin/env bun
/**
 * Project-materialization benchmark: the existing Git path versus an S3
 * repository snapshot, and gzip versus Zstandard.
 *
 * Measures the stage the Config Provider actually replaces — "produce a usable
 * working tree at commit X" — on both sides of the change, with cold and warm
 * caches measured separately, arms interleaved, and warmups excluded.
 *
 * Arms
 *   git-cold        bare mirror clone + shallow checkout, nothing cached.
 *                   This is what a session pays today when no mirror exists.
 *   git-warm        shallow checkout from an already-warm mirror. This is the
 *                   FAVOURABLE baseline; it does not count the mirror clone.
 *   snapshot-cold   S3 GET streamed straight into extraction, empty local cache.
 *   snapshot-warm   local snapshot cache hit (the API-side reader).
 *   prepare-miss    build + publish, i.e. the honest cost of an unprepared
 *                   revision, including source acquisition.
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
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoSnapshot, discardBuiltRepoSnapshot } from '../src/repo-snapshots/build';
import { normalizeRepoSnapshotIdentity } from '../src/repo-snapshots/format';
import { publishRepoSnapshot } from '../src/repo-snapshots/publish';
import { requireRepoSnapshotBucket, s3GetObjectStream } from '../src/repo-snapshots/s3';
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
  cpuMs: number;
  peakRssMb: number;
  networkBytes: number;
  entryCount: number;
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

const scratch = mkdtempSync(join(tmpdir(), 'kortix-bench-'));
process.env.KORTIX_GIT_CACHE_DIR = join(scratch, 'mirrors');
process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR = join(scratch, 'snapshot-cache');

function git(cwd: string, ...rest: string[]): string {
  return execFileSync('git', rest, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function describeRepo(label: string, path: string): RepoTarget {
  const sha = git(path, 'rev-parse', 'HEAD');
  const files = git(path, 'ls-files').split('\n').filter(Boolean);
  const contentBytes = Number(
    execFileSync('bash', ['-lc', `git -C ${JSON.stringify(path)} ls-files -z | xargs -0 wc -c 2>/dev/null | tail -1 | awk '{print $1}'`], {
      encoding: 'utf8',
    }).trim() || 0,
  );
  return { label, path, sha, fileCount: files.length, contentBytes };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; wallMs: number; cpuMs: number; peakRssMb: number }> {
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const value = await fn();
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    value,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    peakRssMb: process.memoryUsage().rss / (1024 * 1024),
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

/** A shallow checkout at an exact SHA — the work a cold session pays today. */
async function gitCheckout(target: RepoTarget, mirror: string, into: string): Promise<number> {
  execFileSync(
    'git',
    ['clone', '--quiet', '--depth', '1', '--no-tags', '--branch', git(target.path, 'rev-parse', '--abbrev-ref', 'HEAD'), `file://${mirror}`, into],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return Number(execFileSync('bash', ['-lc', `du -sk ${JSON.stringify(into)} | cut -f1`], { encoding: 'utf8' }).trim()) * 1024;
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
  const row = {
    snapshotId: cacheKey,
    provider: 'github',
    repositoryId: identity.repositoryId,
    owner: identity.owner,
    repo: identity.repo,
    commitSha: identity.commitSha,
    format: published.manifest.format,
    status: 'ready',
    manifestKey: published.manifestKey,
    payloadKey: published.manifest.payload.key,
    archiveSha256: published.manifest.payload.sha256,
    compression: codec,
    treeSha: published.manifest.source.tree_sha,
    compressedBytes: published.manifest.payload.compressed_bytes,
    expandedBytes: published.manifest.payload.expanded_bytes,
    entryCount: published.manifest.payload.entry_count,
  } as unknown as RepoSnapshotRow;
  const value: Published = {
    row,
    key: published.manifest.payload.key,
    compressedBytes: published.manifest.payload.compressed_bytes,
    entryCount: published.manifest.payload.entry_count,
  };
  publishedCache.set(cacheKey, value);
  return value;
}

async function runArm(arm: Arm, target: RepoTarget, codec: 'gzip' | 'zstd'): Promise<Omit<Sample, 'cohort' | 'repo' | 'codec' | 'arm' | 'round'>> {
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
      return { wallMs: measured.wallMs, cpuMs: measured.cpuMs, peakRssMb: measured.peakRssMb, networkBytes: measured.value, entryCount: target.fileCount };
    }
    if (arm === 'git-warm') {
      let mirror = warmMirrors.get(target.label);
      if (!mirror) {
        mirror = freshMirror(target);
        warmMirrors.set(target.label, mirror);
      }
      const measured = await timed(() => gitCheckout(target, mirror, work));
      return { wallMs: measured.wallMs, cpuMs: measured.cpuMs, peakRssMb: measured.peakRssMb, networkBytes: measured.value, entryCount: target.fileCount };
    }
    if (arm === 'snapshot-cold') {
      const published = await ensurePublished(target, codec);
      // An empty local cache forces the full S3 -> extract path.
      rmSync(join(scratch, 'snapshot-cache'), { recursive: true, force: true });
      const measured = await timed(() => materializeSnapshotLocally(published.row));
      return {
        wallMs: measured.wallMs,
        cpuMs: measured.cpuMs,
        peakRssMb: measured.peakRssMb,
        networkBytes: published.compressedBytes,
        entryCount: published.entryCount,
      };
    }
    if (arm === 'snapshot-warm') {
      const published = await ensurePublished(target, codec);
      await materializeSnapshotLocally(published.row);
      const measured = await timed(() => materializeSnapshotLocally(published.row));
      return { wallMs: measured.wallMs, cpuMs: measured.cpuMs, peakRssMb: measured.peakRssMb, networkBytes: 0, entryCount: published.entryCount };
    }
    // prepare-miss: the honest cost of an unprepared revision.
    const identity = normalizeRepoSnapshotIdentity({
      repositoryId: '424242',
      owner: 'kortix-bench',
      repo: `${target.label}-miss`,
      commitSha: target.sha,
    });
    const measured = await timed(async () => {
      const built = await buildRepoSnapshot(projectFor(target), identity, { compression: codec });
      await discardBuiltRepoSnapshot(built);
      return built.manifest.payload.compressed_bytes;
    });
    return { wallMs: measured.wallMs, cpuMs: measured.cpuMs, peakRssMb: measured.peakRssMb, networkBytes: measured.value, entryCount: 0 };
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
      cpuMsP50: Math.round(quantile(rows.map((r) => r.cpuMs), 50)),
      rssMbP50: Math.round(quantile(rows.map((r) => r.peakRssMb), 50)),
      networkBytes: rows[0]!.networkBytes,
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
          cpuMs: Number.NaN,
          peakRssMb: Number.NaN,
          networkBytes: 0,
          entryCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (round > 0 && round % 5 === 0) console.error(`  round ${round}/${ROUNDS}`);
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

  console.error('\nrepo             codec  arm             n    p50      p90      p95    net(KiB)');
  for (const row of summary.sort((a, b) => a.repo.localeCompare(b.repo) || a.arm.localeCompare(b.arm))) {
    console.error(
      `${row.repo.padEnd(16)} ${row.codec.padEnd(6)} ${row.arm.padEnd(15)} ${String(row.n).padStart(3)} ` +
        `${String(row.p50Ms).padStart(6)}ms ${String(row.p90Ms).padStart(6)}ms ${String(row.p95Ms).padStart(6)}ms ` +
        `${String(Math.round(row.networkBytes / 1024)).padStart(8)}`,
    );
  }

  // The gate the brief proposed: median materialization reduction versus the
  // cold Git fetch cohort. Reported per repo, pass or fail, never smoothed.
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
        snapshotP50Ms: candidate.p50Ms,
        reductionPercent: Number(reduction.toFixed(1)),
        speedup: Number((baseline.p50Ms / candidate.p50Ms).toFixed(2)),
        meets50PercentGate: reduction >= 50,
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
    codecRows.push({
      repo,
      gzipBytes: gzip.networkBytes,
      zstdBytes: zstd.networkBytes,
      sizeDeltaPercent: Number((100 * (zstd.networkBytes - gzip.networkBytes) / gzip.networkBytes).toFixed(1)),
      gzipReadP50Ms: gzip.p50Ms,
      zstdReadP50Ms: zstd.p50Ms,
      gzipBuildP50Ms: gzipBuild?.p50Ms ?? null,
      zstdBuildP50Ms: zstdBuild?.p50Ms ?? null,
    });
  }
  if (codecRows.length) {
    console.error('\ncodec — gzip vs zstd (negative size delta = zstd smaller):');
    for (const row of codecRows) {
      console.error(
        `  ${String(row.repo).padEnd(12)} gzip=${Math.round(Number(row.gzipBytes) / 1024)}KiB/${row.gzipReadP50Ms}ms  ` +
          `zstd=${Math.round(Number(row.zstdBytes) / 1024)}KiB/${row.zstdReadP50Ms}ms  size ${row.sizeDeltaPercent}%`,
      );
    }
  }

  console.error('\ngate — median project materialization, cold cohort:');
  for (const gate of gates) {
    console.error(
      `  ${gate.repo}/${gate.codec}: ${gate.baselineP50Ms}ms -> ${gate.snapshotP50Ms}ms ` +
        `(${gate.reductionPercent}% reduction, ${gate.speedup}x) ${gate.meets50PercentGate ? 'PASS' : 'FAIL'}`,
    );
  }

  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, 'raw.json'),
      JSON.stringify({ env, targets, rounds: ROUNDS, warmups: WARMUPS, samples, summary, gates, codecRows }, null, 2),
    );
    const csv = ['repo,codec,arm,round,wall_ms,cpu_ms,peak_rss_mb,network_bytes,entry_count,error'];
    for (const s of samples) {
      csv.push(
        [s.repo, s.codec, s.arm, s.round, s.wallMs.toFixed(3), s.cpuMs.toFixed(3), s.peakRssMb.toFixed(1), s.networkBytes, s.entryCount, s.error ?? ''].join(','),
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
      '| repo | codec | arm | n | p50 ms | p90 ms | p95 ms | CPU p50 ms | net KiB | entries |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...summary.map(
        (r) =>
          `| ${r.repo} | ${r.codec} | ${r.arm} | ${r.n} | ${r.p50Ms} | ${r.p90Ms} | ${r.p95Ms} | ${r.cpuMsP50} | ${Math.round(r.networkBytes / 1024)} | ${r.entryCount} |`,
      ),
      '',
      '## Codec — gzip versus Zstandard',
      '',
      '| repo | gzip bytes | zstd bytes | size delta | gzip read p50 | zstd read p50 | gzip build p50 | zstd build p50 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...codecRows.map(
        (c) =>
          `| ${c.repo} | ${c.gzipBytes} | ${c.zstdBytes} | ${c.sizeDeltaPercent}% | ${c.gzipReadP50Ms} ms | ${c.zstdReadP50Ms} ms | ${c.gzipBuildP50Ms ?? 'n/a'} ms | ${c.zstdBuildP50Ms ?? 'n/a'} ms |`,
      ),
      '',
      '## Gate — median project materialization, cold cohort',
      '',
      '| repo | codec | baseline p50 | snapshot p50 | reduction | speedup | >= 50% |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...gates.map(
        (g) =>
          `| ${g.repo} | ${g.codec} | ${g.baselineP50Ms} ms | ${g.snapshotP50Ms} ms | ${g.reductionPercent}% | ${g.speedup}x | ${g.meets50PercentGate ? 'PASS' : 'FAIL'} |`,
      ),
      '',
      '## Reading these numbers honestly',
      '',
      '- Download and extraction OVERLAP in the snapshot arms. Their durations',
      '  are never summed and presented as a saving.',
      '- `git-warm` excludes the mirror clone. It is the favourable baseline, not',
      '  what a cold session pays.',
      '- Both sides are LOCAL here: the Git arms read a `file://` mirror and the',
      '  snapshot arms read a local S3 endpoint. Neither pays a wide-area',
      '  transfer, so the measured gap is the WORK, not the network. In',
      '  production the Git arm additionally pays a GitHub round trip that the',
      '  snapshot arm does not, so these figures are a lower bound on the',
      '  end-to-end improvement, not an estimate of it.',
      '- `snapshot-warm` is a local cache hit: a stat call, not a transfer.',
      '- End-to-end session readiness is NOT measured here. It needs a real',
      '  sandbox; use `scripts/bench-boot-attribution.ts` against a deployment.',
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
