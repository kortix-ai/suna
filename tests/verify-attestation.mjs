#!/usr/bin/env node
// Local test attestation: `pnpm test` proves it ran by writing
// tests/attestations/<branch>.json; the pre-push hook checks it (no CI job does).
// One file per branch, so two PRs never edit the same path and never conflict.
// A write deletes every other branch's file (and the legacy
// tests/test-attestation.json): a merged PR's file is never edited again, so
// two branches that delete it merge clean.
//
//   node tests/verify-attestation.mjs verify [--rev <sha>] [--branch <name>] [--require a,b] [--strict]
//   node tests/verify-attestation.mjs write <lane>=<pass|fail|skipped-no-db|skipped-unaffected> ...
//   node tests/verify-attestation.mjs status   # {files, lanes} for the diff-scoped runner
//   node tests/verify-attestation.mjs fingerprint   # source_hash of the working tree now
//
// `pnpm test` takes the fingerprint before its lanes start and passes it to
// write as KORTIX_ATTEST_FINGERPRINT. write refuses when the source changed
// since: a commit made while the lanes ran was never tested, and a write
// hashes the tree as it is at the END of the run.
//
// verify reads the attestation the PR itself added or edited under
// tests/attestations/ (`git diff origin/dev...rev`). With none, it reads
// tests/attestations/<branch>.json at rev (--branch, else the checked-out
// branch), then the legacy tests/test-attestation.json.
//
// diff_hash = sha256 of "<mode> <blob> <path>" for the files the PR itself
// changed — `git diff origin/dev...HEAD`, minus every attestation file. Verify
// stays green while those files are unchanged, even after an unrelated
// origin/dev merge lands other files; it goes stale only when a file the PR
// changed is edited after the run. On dev (no diverging merge-base) it falls
// back to source_hash: sha256 over every file the commit would contain. Both
// are recomputed from `--rev`, so committing the attestation never changes them.
// A write hashes the working tree (uncommitted edits included), so committing
// exactly what was tested afterwards keeps the attestation fresh.
//
// Lanes: core (sdk, runner units, route coverage, worktree units), packages
// (package quality), db-suites (the Docker-backed lanes: API/CLI flows + DB
// suites), browser (only when run). Two skips exist, both for db-suites and
// neither a pass: "skipped-no-db" (no Docker) and "skipped-unaffected" (the
// diff-scoped run found no change the flows or DB suites read).
//
// verify exit codes: 0 green | 1 missing, stale, or red. With --strict a green
// attestation with a skipped lane exits 3 instead of 0.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIR = 'tests/attestations';
export const LEGACY = 'tests/test-attestation.json';
export const REQUIRED_LANES = ['core', 'packages', 'db-suites'];

const git = (args, env) =>
  execFileSync('git', args, { cwd: root, env: { ...process.env, ...env }, maxBuffer: 1 << 28 });

/** Attestation files are never part of the tested source. */
const isAttestation = (p) => p === LEGACY || p.startsWith(`${DIR}/`);

/** tests/attestations/<branch>.json, with every char outside [A-Za-z0-9._-] made `-`. */
export const attestationPath = (branch) => `${DIR}/${branch.replace(/[^A-Za-z0-9._-]/g, '-')}.json`;

/** The checked-out branch, or null on a detached HEAD. */
function currentBranch() {
  try {
    return git(['symbolic-ref', '--short', '-q', 'HEAD']).toString().trim() || null;
  } catch {
    return null;
  }
}

/** The tree of the working tree (staged + unstaged + untracked, not ignored), via a scratch index. */
function workingTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'attest-index-'));
  const index = join(tmp, 'index');
  try {
    const real = resolve(root, git(['rev-parse', '--git-path', 'index']).toString().trim());
    copyFileSync(real, index);
    // Keep the index mtime: git re-hashes an entry whose file is not older than
    // the index (its racy-entry check). A fresh copy mtime would let `add -A`
    // trust the stat of a same-size edit made in the second of the last write.
    const { atime, mtime } = statSync(real);
    utimesSync(index, atime, mtime);
  } catch {} // no index yet: `add -A` builds one
  const env = { GIT_INDEX_FILE: index };
  git(['add', '-A'], env);
  const tree = git(['write-tree'], env).toString().trim();
  rmSync(tmp, { recursive: true, force: true });
  return tree;
}

/** Hash the tree of `rev`, or of the working tree. */
export function sourceHash(rev) {
  const tree = rev ?? workingTree();
  const entries = git(['ls-tree', '-r', '-z', tree]).toString().split('\0').filter(Boolean);
  const lines = entries
    .map((e) => {
      const [meta, path] = e.split('\t');
      const [mode, , blob] = meta.split(' ');
      return { path, line: `${mode} ${blob} ${path}` };
    })
    .filter((e) => !isAttestation(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return createHash('sha256').update(lines.map((e) => e.line).join('\n')).digest('hex');
}

const sha = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

/**
 * The files the PR itself changed: `git diff <merge-base origin/dev>...<rev>`,
 * or against the working tree when `rev` is omitted.
 * Returns { files: sorted paths, lines: { path -> "<mode> <blob> <path>" }, hash,
 * attestations: the files the PR added or edited under tests/attestations/ },
 * or null when there is no diverging merge-base (on/behind dev with nothing
 * uncommitted, or origin/dev unavailable) — the caller then falls back to the
 * full-tree source_hash.
 */
export function changedFiles(rev) {
  try {
    git(['fetch', 'origin', 'dev', '--quiet']); // best-effort: compare against the latest dev
  } catch {}
  let base;
  let head;
  try {
    head = git(['rev-parse', rev ?? 'HEAD']).toString().trim();
    base = git(['merge-base', 'origin/dev', head]).toString().trim();
  } catch {
    return null; // no origin/dev (unrelated histories) → full-tree fallback
  }
  if (!base || (rev && base === head)) return null; // on or behind dev → full-tree fallback
  const target = rev ? head : workingTree();
  const tokens = git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, target])
    .toString()
    .split('\0')
    .filter(Boolean);
  const entries = [];
  const attestations = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [, mode, , blob, status] = tokens[i].replace(/^:/, '').split(' '); // :srcmode dstmode srcsha dstsha status
    const path = tokens[i + 1];
    if (!isAttestation(path)) entries.push({ path, line: `${mode} ${blob} ${path}` });
    else if (path.startsWith(`${DIR}/`) && status !== 'D') attestations.push(path);
  }
  if (base === head && entries.length === 0) return null; // a clean checkout of dev
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const lines = Object.fromEntries(entries.map((e) => [e.path, e.line]));
  return { files: entries.map((e) => e.path), lines, hash: sha(entries.map((e) => e.line)), attestations };
}

const readdirSafe = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** True when the attestation's tested source is unchanged at `current`. */
function isFresh(attestation, current) {
  if (attestation.diff_hash !== undefined && current.changed) {
    const { lines } = current.changed;
    // Every file the PR changed must still be a changed file with the same blob.
    if (attestation.diff_files.some((p) => lines[p] === undefined)) return false;
    return sha(attestation.diff_files.map((p) => lines[p])) === attestation.diff_hash;
  }
  return attestation.source_hash === current.sourceHash; // fallback / legacy attestation
}

/** Pure check. `current` = { sourceHash, changed }. Returns { code, reason }. */
export function evaluate(attestation, current, required = REQUIRED_LANES, strict = false) {
  if (!attestation) return { code: 1, reason: 'missing' };
  if (!isFresh(attestation, current)) return { code: 1, reason: 'stale' };
  const lanes = attestation.lanes ?? {};
  if (attestation.passed !== true || Object.values(lanes).includes('fail')) {
    return { code: 1, reason: 'red' };
  }
  // The only allowed skips: db-suites without Postgres (no Docker), and
  // db-suites on a diff that cannot affect it. `packages` has no skip: a
  // factory sandbox runs it like any laptop. Mirrors the company merge gate's G11 rule.
  const SKIPS = { 'db-suites': ['skipped-no-db', 'skipped-unaffected'] };
  const isSkip = (l) => SKIPS[l]?.includes(lanes[l]) ?? false;
  const ok = (l) => lanes[l] === 'pass' || isSkip(l);
  const bad = [...new Set([...required, ...Object.keys(lanes)])].filter((l) => !ok(l));
  if (bad.length) return { code: 1, reason: `lane not run or not green: ${bad.join(',')}` };
  // A diff that changes the schema package must have run the DB suites. The
  // skipped-no-db escape is for diffs the DB cannot affect.
  const touchesDb = (current.changed?.files ?? []).some((p) => p.startsWith('packages/db/'));
  if (touchesDb && lanes['db-suites'] !== 'pass') {
    return { code: 1, reason: 'db-suites must pass: this diff changes packages/db and skipped-no-db is not accepted' };
  }
  const skipped = Object.keys(SKIPS).filter(isSkip);
  if (skipped.length) {
    return { code: strict ? 3 : 0, reason: `green, skipped: ${skipped.map((l) => `${l} ${lanes[l]}`).join(', ')}` };
  }
  return { code: 0, reason: 'green' };
}

function read(path, rev) {
  try {
    const raw = rev ? git(['show', `${rev}:${path}`]).toString() : readFileSync(join(root, path), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The attestation for `rev`: the PR's own file, else <branch>.json at rev, else the legacy file. */
export function locate(rev, branch, changed) {
  const mine = branch && attestationPath(branch);
  const own = changed?.attestations ?? [];
  if (own.includes(mine)) return read(mine, rev);
  if (own.length) {
    const docs = own.map((p) => read(p, rev)).filter(Boolean);
    return docs.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null; // newest
  }
  return (mine && read(mine, rev)) ?? read(LEGACY, rev);
}

const ownPath = () =>
  attestationPath(currentBranch() ?? `detached-${git(['rev-parse', '--short', 'HEAD']).toString().trim()}`);

/**
 * This branch's attestation, when it tested exactly `current`: fresh, and no
 * file joined the diff since (verify tolerates one; reusing a lane must not).
 */
function freshPrior(path, current) {
  const prior = read(path);
  if (!prior || !isFresh(prior, current)) return null;
  const sameFiles = !current.changed || prior.diff_files?.length === current.changed.files.length;
  return sameFiles ? prior : null;
}

/**
 * Record lane results for the current source in this branch's file, and delete
 * every other attestation file. Lanes accumulate while the attestation stays
 * fresh: the same PR diff (an unrelated dev merge keeps it), else the same tree.
 */
export function write(results) {
  const source_hash = sourceHash();
  const diff = changedFiles();
  const path = ownPath();
  const prior = freshPrior(path, { sourceHash: source_hash, changed: diff });
  const lanes = prior ? { ...prior.lanes, ...results } : { ...results };
  const attestation = {
    source_hash,
    ...(diff ? { diff_files: diff.files, diff_hash: diff.hash } : {}),
    head: git(['rev-parse', 'HEAD']).toString().trim(),
    passed: !Object.values(lanes).includes('fail'),
    lanes,
    at: new Date().toISOString(),
  };
  const others = [LEGACY, ...readdirSafe(join(root, DIR)).map((f) => `${DIR}/${f}`)].filter(
    (p) => p !== path && (p === LEGACY || p.endsWith('.json')),
  );
  // Stage the deletions too (`git rm`), so a commit of only this file still prunes.
  git(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...others]);
  for (const p of others) rmSync(join(root, p), { force: true });
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(join(root, path), `${JSON.stringify(attestation, null, 2)}\n`);
  return { path, attestation };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (cmd === 'fingerprint') {
    console.log(sourceHash());
  } else if (cmd === 'write') {
    const started = process.env.KORTIX_ATTEST_FINGERPRINT;
    if (started && started !== sourceHash()) {
      console.error(
        '[attest] the source changed during this run, so these results do not cover it. Nothing written. Re-run pnpm test.',
      );
      process.exit(1);
    }
    const results = Object.fromEntries(args.map((a) => a.split('=')));
    const { path, attestation } = write(results);
    console.log(`[attest] wrote ${path}: ${JSON.stringify(attestation.lanes)}`);
  } else if (cmd === 'status') {
    // The diff-scoped runner's input: the working tree's PR diff (null on dev)
    // and the lanes this branch's attestation still holds for it.
    const changed = changedFiles();
    const prior = freshPrior(ownPath(), { sourceHash: sourceHash(), changed });
    console.log(JSON.stringify({ files: changed?.files ?? null, lanes: prior?.lanes ?? {} }));
  } else if (cmd === 'verify') {
    const rev = flag('--rev');
    const required = flag('--require')?.split(',') ?? REQUIRED_LANES;
    const current = { sourceHash: sourceHash(rev), changed: changedFiles(rev) };
    const attestation = locate(rev, flag('--branch') ?? currentBranch(), current.changed);
    const { code, reason } = evaluate(attestation, current, required, args.includes('--strict'));
    console.log(`[attest] ${code === 0 ? 'OK' : code === 3 ? 'PARTIAL' : 'FAIL'} ${reason}`);
    process.exit(code);
  } else {
    console.error(
      'usage: verify [--rev <sha>] [--branch <name>] [--require a,b] [--strict] | write <lane>=<result>... | status | fingerprint',
    );
    process.exit(2);
  }
}
