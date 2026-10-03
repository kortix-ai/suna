#!/usr/bin/env node
// Local test attestation: `pnpm test` proves it ran by writing
// tests/test-attestation.json; the pre-push hook and the merge gate check it.
//
//   node tests/verify-attestation.mjs verify [--rev <sha>] [--require a,b] [--strict]
//   node tests/verify-attestation.mjs write <lane>=<pass|fail|skipped-no-db> ...
//
// diff_hash = sha256 of "<mode> <blob> <path>" for the files the PR itself
// changed — `git diff origin/main...HEAD`, minus the attestation file. Verify
// stays green while those files are unchanged, even after an unrelated
// origin/main merge lands other files; it goes stale only when a file the PR
// changed is edited after the run. On main (no diverging merge-base) it falls
// back to source_hash: sha256 over every file the commit would contain. Both
// are recomputed from `--rev`, so committing the attestation never changes them.
//
// Lanes: core (sdk, runner units, route coverage, worktree units), packages
// (package quality), db-suites (the Docker-backed lanes: API/CLI flows + DB
// suites), browser (only when run). db-suites may be "skipped-no-db" (no
// Docker) and packages "skipped-sandbox-image" (a Kortix sandbox image);
// neither is a pass. The merge gate holds a DB-touching PR on it.
//
// verify exit codes: 0 green | 1 missing, stale, or red. With --strict a green
// attestation with any sanctioned skip exits 3 instead of 0.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ATTESTATION = 'tests/test-attestation.json';
export const REQUIRED_LANES = ['core', 'packages', 'db-suites'];

const git = (args, env) =>
  execFileSync('git', args, { cwd: root, env: { ...process.env, ...env }, maxBuffer: 1 << 28 });

/** Hash the tree of `rev`, or of the working tree (staged + unstaged + untracked, not ignored). */
export function sourceHash(rev) {
  let tree;
  let tmp;
  if (rev) {
    tree = rev;
  } else {
    tmp = mkdtempSync(join(tmpdir(), 'attest-index-'));
    const index = join(tmp, 'index');
    try {
      copyFileSync(resolve(root, git(['rev-parse', '--git-path', 'index']).toString().trim()), index);
    } catch {} // no index yet: `add -A` builds one
    const env = { GIT_INDEX_FILE: index };
    git(['add', '-A'], env);
    tree = git(['write-tree'], env).toString().trim();
    rmSync(tmp, { recursive: true, force: true });
  }
  const entries = git(['ls-tree', '-r', '-z', tree]).toString().split('\0').filter(Boolean);
  const lines = entries
    .map((e) => {
      const [meta, path] = e.split('\t');
      const [mode, , blob] = meta.split(' ');
      return { path, line: `${mode} ${blob} ${path}` };
    })
    .filter((e) => e.path !== ATTESTATION)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return createHash('sha256').update(lines.map((e) => e.line).join('\n')).digest('hex');
}

const sha = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

/**
 * The files the PR itself changed: `git diff <merge-base origin/main>...<rev>`.
 * Returns { files: sorted paths, lines: { path -> "<mode> <blob> <path>" }, hash },
 * or null when there is no diverging merge-base (on/behind main, or origin/main
 * unavailable) — the caller then falls back to the full-tree source_hash.
 */
export function changedFiles(rev) {
  try {
    git(['fetch', 'origin', 'main', '--quiet']); // best-effort: compare against the latest main
  } catch {}
  let base;
  let head;
  try {
    head = git(['rev-parse', rev ?? 'HEAD']).toString().trim();
    base = git(['merge-base', 'origin/main', head]).toString().trim();
  } catch {
    return null; // no origin/main (unrelated histories) → full-tree fallback
  }
  if (!base || base === head) return null; // on or behind main → full-tree fallback
  const tokens = git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, head])
    .toString()
    .split('\0')
    .filter(Boolean);
  const entries = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [, mode, , blob] = tokens[i].replace(/^:/, '').split(' '); // :srcmode dstmode srcsha dstsha status
    const path = tokens[i + 1];
    if (path !== ATTESTATION) entries.push({ path, line: `${mode} ${blob} ${path}` });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const lines = Object.fromEntries(entries.map((e) => [e.path, e.line]));
  return { files: entries.map((e) => e.path), lines, hash: sha(entries.map((e) => e.line)) };
}

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

/** Lane results that record a sanctioned environment skip instead of a run.
 *  `db-suites: skipped-no-db` — no Docker (no local Postgres). `packages:
 *  skipped-sandbox-image` — a Kortix sandbox image, whose baked box state
 *  (/opt/kortix catalog, /opt/suna scaffold, /etc/pt-env) the agent-server
 *  suites depend on; the scheduled Tests run on a clean CI runner is the
 *  backstop. A skip is never a pass, and `--strict` (a push to main) rejects
 *  one. */
export const SANCTIONED_SKIP = { 'db-suites': 'skipped-no-db', packages: 'skipped-sandbox-image' };

/** Pure check. `current` = { sourceHash, changed }. Returns { code, reason }. */
export function evaluate(attestation, current, required = REQUIRED_LANES, strict = false) {
  if (!attestation) return { code: 1, reason: 'missing' };
  if (!isFresh(attestation, current)) return { code: 1, reason: 'stale' };
  const lanes = attestation.lanes ?? {};
  if (attestation.passed !== true || Object.values(lanes).includes('fail')) {
    return { code: 1, reason: 'red' };
  }
  const ok = (l) => lanes[l] === 'pass' || (SANCTIONED_SKIP[l] !== undefined && lanes[l] === SANCTIONED_SKIP[l]);
  const bad = [...new Set([...required, ...Object.keys(lanes)])].filter((l) => !ok(l));
  if (bad.length) return { code: 1, reason: `lane not run or not green: ${bad.join(',')}` };
  const skipped = Object.keys(SANCTIONED_SKIP).filter((l) => lanes[l] !== undefined && lanes[l] !== 'pass');
  if (skipped.length) {
    return { code: strict ? 3 : 0, reason: `green, ${skipped.join(' + ')} skipped` };
  }
  return { code: 0, reason: 'green' };
}

function read(rev) {
  try {
    const raw = rev
      ? git(['show', `${rev}:${ATTESTATION}`]).toString()
      : readFileSync(join(root, ATTESTATION), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Record lane results for the current source. Lanes of the same source_hash accumulate. */
export function write(results) {
  const source_hash = sourceHash();
  const diff = changedFiles();
  const prior = read();
  const lanes = prior?.source_hash === source_hash ? { ...prior.lanes, ...results } : { ...results };
  const attestation = {
    source_hash,
    ...(diff ? { diff_files: diff.files, diff_hash: diff.hash } : {}),
    head: git(['rev-parse', 'HEAD']).toString().trim(),
    passed: !Object.values(lanes).includes('fail'),
    lanes,
    at: new Date().toISOString(),
  };
  writeFileSync(join(root, ATTESTATION), `${JSON.stringify(attestation, null, 2)}\n`);
  return attestation;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (cmd === 'write') {
    const results = Object.fromEntries(args.map((a) => a.split('=')));
    console.log(`[attest] wrote ${ATTESTATION}: ${JSON.stringify(write(results).lanes)}`);
  } else if (cmd === 'verify') {
    const rev = flag('--rev');
    const required = flag('--require')?.split(',') ?? REQUIRED_LANES;
    const current = { sourceHash: sourceHash(rev), changed: changedFiles(rev) };
    const { code, reason } = evaluate(read(rev), current, required, args.includes('--strict'));
    console.log(`[attest] ${code === 0 ? 'OK' : code === 3 ? 'PARTIAL' : 'FAIL'} ${reason}`);
    process.exit(code);
  } else {
    console.error('usage: verify [--rev <sha>] [--require a,b] [--strict] | write <lane>=<result>...');
    process.exit(2);
  }
}
