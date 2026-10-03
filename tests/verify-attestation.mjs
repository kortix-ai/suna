#!/usr/bin/env node
// Local test attestation: `pnpm test` proves it ran by writing
// tests/attestations/<branch>.json; the pre-push hook and the merge gate check it.
// One file per branch, so two PRs never edit the same path and never conflict.
// A write deletes every other branch's file (and the legacy
// tests/test-attestation.json): a merged PR's file is never edited again, so
// two branches that delete it merge clean.
//
//   node tests/verify-attestation.mjs verify [--rev <sha>] [--branch <name>] [--require a,b] [--strict]
//   node tests/verify-attestation.mjs write <lane>=<pass|fail|skipped-no-db|skipped-sandbox-image> ...
//
// verify reads the attestation the PR itself added or edited under
// tests/attestations/ (`git diff origin/main...rev`). With none, it reads
// tests/attestations/<branch>.json at rev (--branch, else the checked-out
// branch), then the legacy tests/test-attestation.json.
//
// diff_hash = sha256 of "<mode> <blob> <path>" for the files the PR itself
// changed — `git diff origin/main...HEAD`, minus every attestation file. Verify
// stays green while those files are unchanged, even after an unrelated
// origin/main merge lands other files; it goes stale only when a file the PR
// changed is edited after the run. On main (no diverging merge-base) it falls
// back to source_hash: sha256 over every file the commit would contain. Both
// are recomputed from `--rev`, so committing the attestation never changes them.
//
// Lanes: core (sdk, runner units, route coverage, worktree units), packages
// (package quality), db-suites (the Docker-backed lanes: API/CLI flows + DB
// suites), browser (only when run). Two sanctioned environment skips exist;
// neither is ever a pass, and --strict refuses both:
//   db-suites: skipped-no-db — the box has no Docker (a factory sandbox), so
//     the DB lanes cannot run; the merge gate holds a DB-touching PR on it.
//   packages: skipped-sandbox-image — the Kortix sandbox image's platform state
//     (/etc/pt-env, /opt/kortix/{scaffold.git,managed-skills,llm-catalog.json},
//     a git repo at /workspace, the /dev/shm env file) breaks agent-server
//     tests that are byte-identical at origin/main, so the lane cannot attest
//     a PR there (Marko, 2026-10-03). The daily scheduled Tests run and every
//     release PR run the same command on a clean CI runner, the backstop.
//
// verify exit codes: 0 green | 1 missing, stale, or red. With --strict a green
// attestation with a sanctioned skip (db-suites or packages) exits 3 instead of 0.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIR = 'tests/attestations';
export const LEGACY = 'tests/test-attestation.json';
export const REQUIRED_LANES = ['core', 'packages', 'db-suites'];

/** Sanctioned environment skips, per lane. Never a pass; --strict refuses both. */
export const SANCTIONED_SKIPS = {
  'db-suites': 'skipped-no-db',
  packages: 'skipped-sandbox-image',
};

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
    .filter((e) => !isAttestation(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return createHash('sha256').update(lines.map((e) => e.line).join('\n')).digest('hex');
}

const sha = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

/**
 * The files the PR itself changed: `git diff <merge-base origin/main>...<rev>`.
 * Returns { files: sorted paths, lines: { path -> "<mode> <blob> <path>" }, hash,
 * attestations: the files the PR added or edited under tests/attestations/ },
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
  const attestations = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [, mode, , blob, status] = tokens[i].replace(/^:/, '').split(' '); // :srcmode dstmode srcsha dstsha status
    const path = tokens[i + 1];
    if (!isAttestation(path)) entries.push({ path, line: `${mode} ${blob} ${path}` });
    else if (path.startsWith(`${DIR}/`) && status !== 'D') attestations.push(path);
  }
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
  const ok = (l) =>
    lanes[l] === 'pass' || (SANCTIONED_SKIPS[l] !== undefined && lanes[l] === SANCTIONED_SKIPS[l]);
  const bad = [...new Set([...required, ...Object.keys(lanes)])].filter((l) => !ok(l));
  if (bad.length) return { code: 1, reason: `lane not run or not green: ${bad.join(',')}` };
  const skipped = Object.keys(SANCTIONED_SKIPS).filter((l) => lanes[l] === SANCTIONED_SKIPS[l]);
  if (skipped.length) {
    return {
      code: strict ? 3 : 0,
      reason: `green, ${skipped.map((l) => `${l} ${SANCTIONED_SKIPS[l]}`).join(', ')}`,
    };
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

/**
 * Record lane results for the current source in this branch's file, and delete
 * every other attestation file. Lanes of the same source_hash accumulate.
 */
export function write(results) {
  const source_hash = sourceHash();
  const diff = changedFiles();
  const path = attestationPath(
    currentBranch() ?? `detached-${git(['rev-parse', '--short', 'HEAD']).toString().trim()}`,
  );
  const prior = read(path);
  const lanes = prior?.source_hash === source_hash ? { ...prior.lanes, ...results } : { ...results };
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
  if (cmd === 'write') {
    const results = Object.fromEntries(args.map((a) => a.split('=')));
    const { path, attestation } = write(results);
    console.log(`[attest] wrote ${path}: ${JSON.stringify(attestation.lanes)}`);
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
      'usage: verify [--rev <sha>] [--branch <name>] [--require a,b] [--strict] | write <lane>=<result>...',
    );
    process.exit(2);
  }
}
