#!/usr/bin/env node
// Local test attestation: `pnpm test` proves it ran by writing
// tests/test-attestation.json; the pre-push hook and the merge gate check it.
//
//   node tests/verify-attestation.mjs verify [--rev <sha>] [--require a,b] [--strict]
//   node tests/verify-attestation.mjs write <lane>=<pass|fail|skipped-no-db> ...
//
// source_hash = sha256 of "<mode> <blob> <path>" for every file the working
// tree (or --rev) would commit, minus the attestation file. Same input, same
// hash, on any machine: committing the attestation does not change it.
//
// Lanes: core (sdk, runner units, route coverage, worktree units), packages
// (package quality), db-suites (the Docker-backed lanes: API/CLI flows + DB
// suites), browser (only when run). db-suites alone may be "skipped-no-db";
// that is never a pass. The merge gate holds a DB-touching PR on it.
//
// verify exit codes: 0 green | 1 missing, stale, or red. With --strict a green
// attestation whose db-suites was skipped exits 3 instead of 0.
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

/** Pure check. Returns { code, reason }. */
export function evaluate(attestation, currentHash, required = REQUIRED_LANES, strict = false) {
  if (!attestation) return { code: 1, reason: 'missing' };
  if (attestation.source_hash !== currentHash) return { code: 1, reason: 'stale' };
  const lanes = attestation.lanes ?? {};
  if (attestation.passed !== true || Object.values(lanes).includes('fail')) {
    return { code: 1, reason: 'red' };
  }
  const ok = (l) => lanes[l] === 'pass' || (l === 'db-suites' && lanes[l] === 'skipped-no-db');
  const bad = [...new Set([...required, ...Object.keys(lanes)])].filter((l) => !ok(l));
  if (bad.length) return { code: 1, reason: `lane not run or not green: ${bad.join(',')}` };
  if (lanes['db-suites'] === 'skipped-no-db') {
    return { code: strict ? 3 : 0, reason: 'green, db-suites skipped-no-db' };
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
  const prior = read();
  const lanes = prior?.source_hash === source_hash ? { ...prior.lanes, ...results } : { ...results };
  const attestation = {
    source_hash,
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
    const { code, reason } = evaluate(read(rev), sourceHash(rev), required, args.includes('--strict'));
    console.log(`[attest] ${code === 0 ? 'OK' : code === 3 ? 'PARTIAL' : 'FAIL'} ${reason}`);
    process.exit(code);
  } else {
    console.error('usage: verify [--rev <sha>] [--require a,b] [--strict] | write <lane>=<result>...');
    process.exit(2);
  }
}
