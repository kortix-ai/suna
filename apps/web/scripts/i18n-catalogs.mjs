#!/usr/bin/env node

// Translation catalogs: `apps/web/translations/<locale>.json`.
//
// Key order is part of a catalog. Nothing at runtime reads it, but everything
// that edits a catalog does: a merge, a review diff, and the starter-prompt
// contract (`starterPrompts.items` follows `STARTER_PROMPTS`, asserted by
// `src/lib/starter-prompts.test.ts`). Each catalog is ~1.5 MB and nearly every
// feature adds keys to all nine, so they conflict on almost every merge of
// `main`. On 2026-09-22 one such conflict was resolved by a program that
// rebuilt every object through an unordered key set (merge `aba5055432`,
// landed in `ea09f2f6a8`): 473 of 840 objects in every catalog changed order,
// each file's diff was ~38,500 lines, 4 deleted keys came back, and
// `starter-prompts.test.ts` turned the packages lane red on `main`.
//
// This file owns the three things that stop a repeat:
//
// - `merge-driver` — the git merge driver for the catalogs (`.gitattributes`
//   routes them here; the root `prepare` script registers it on
//   `pnpm install`). It merges the three versions key by key and keeps both
//   sides' order, so two branches that add keys never conflict. A key changed
//   two different ways comes back as ordinary conflict markers around that
//   key only.
// - `check` — every catalog is canonical (`JSON.stringify(value, null, 2)`),
//   and with `--base=<rev>` no object reorders keys it shares with that
//   revision. `.github/workflows/i18n-catalogs.yml` runs it on every pull
//   request that touches a catalog.
// - `restore-order --from=<rev>...` — puts every object back in the order of
//   the given revisions without changing a value: the repair for a failed
//   `check`.
//
// Usage (paths are relative to the repository root):
//   node apps/web/scripts/i18n-catalogs.mjs check [--base=origin/main]
//   node apps/web/scripts/i18n-catalogs.mjs format
//   node apps/web/scripts/i18n-catalogs.mjs restore-order --from=<rev> [--from=<rev>]
//   node apps/web/scripts/i18n-catalogs.mjs merge-driver %O %A %B %L %P %S %X %Y

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { locales } from '../src/i18n/catalog.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const catalogFiles = locales.map((locale) =>
  path.join(webRoot, 'translations', `${locale}.json`),
);

/** The pull-request label that allows an intentional reorder past `check`. */
export const REORDER_LABEL = 'i18n-reorder';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

/** True when `a` and `b` hold the same keys and values in any key order. */
export function sameIgnoringOrder(a, b) {
  return same(sortedKeys(a), sortedKeys(b));
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The one committed form of a catalog. `JSON.parse` + this is lossless. */
export function serializeCatalog(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Every object whose keys, where `after` shares them with `before`, are not in
 * `before`'s order. Added and removed keys are not changes; a key that moved
 * is. Each entry names the first position that differs.
 */
export function findKeyOrderChanges(before, after) {
  const changes = [];
  (function walk(b, a, at) {
    if (!isPlainObject(b) || !isPlainObject(a)) return;
    const shared = Object.keys(a).filter((key) => has(b, key));
    const expected = Object.keys(b).filter((key) => has(a, key));
    const index = expected.findIndex((key, i) => shared[i] !== key);
    if (index !== -1) {
      changes.push({
        path: at,
        index,
        expected: expected[index],
        actual: shared[index],
        shared: shared.length,
      });
    }
    for (const key of shared) walk(b[key], a[key], [...at, key]);
  })(before, after, []);
  return changes;
}

/**
 * Appends `keys` to `order`, in order, skipping keys not in `keep`. A key that
 * is already placed becomes the anchor; a new key goes right after the last
 * anchor, so it lands next to the key it followed in `keys`.
 */
function placeAfterPredecessors(order, placed, keys, keep) {
  let anchor = -1;
  for (const key of keys) {
    if (!keep.has(key)) continue;
    if (placed.has(key)) {
      anchor = order.indexOf(key);
      continue;
    }
    order.splice(anchor + 1, 0, key);
    placed.add(key);
    anchor += 1;
  }
}

function reorderedSince(baseKeys, sideKeys) {
  const inSide = new Set(sideKeys);
  const inBase = new Set(baseKeys);
  const expected = baseKeys.filter((key) => inSide.has(key));
  const actual = sideKeys.filter((key) => inBase.has(key));
  return expected.some((key, i) => actual[i] !== key);
}

/**
 * The merged order of one object's keys. The side that reordered its existing
 * keys is the trunk (ours when both or neither did); the other side's new keys
 * follow the key they followed on that side.
 */
export function mergeKeyOrder(baseKeys, oursKeys, theirsKeys, keep) {
  const theirsFirst = reorderedSince(baseKeys, theirsKeys) && !reorderedSince(baseKeys, oursKeys);
  const [trunk, other] = theirsFirst ? [theirsKeys, oursKeys] : [oursKeys, theirsKeys];
  const order = [];
  const placed = new Set();
  placeAfterPredecessors(order, placed, trunk, keep);
  placeAfterPredecessors(order, placed, other, keep);
  return order;
}

function present(value) {
  return value === undefined ? { present: false } : { present: true, value };
}

/**
 * Three-way merge of two catalogs, key by key. `base` is `undefined` when both
 * sides added the file. Returns the merged value and every key the two sides
 * changed in different ways; a conflicting key holds ours in `value`.
 */
export function mergeCatalogs(base, ours, theirs) {
  const conflicts = [];

  function mergeValue(b, o, t, at) {
    if (same(o, t)) return o;
    if (b !== undefined && same(b, o)) return t;
    if (b !== undefined && same(b, t)) return o;
    if (isPlainObject(o) && isPlainObject(t))
      return mergeObject(isPlainObject(b) ? b : {}, o, t, at);
    conflicts.push({ path: at, base: present(b), ours: present(o), theirs: present(t) });
    return o;
  }

  function mergeObject(b, o, t, at) {
    const values = new Map();
    for (const key of new Set([...Object.keys(o), ...Object.keys(t)])) {
      const inBase = has(b, key);
      const inOurs = has(o, key);
      const inTheirs = has(t, key);
      const where = [...at, key];
      if (inOurs && inTheirs) {
        values.set(key, mergeValue(inBase ? b[key] : undefined, o[key], t[key], where));
      } else {
        // One side lacks the key: the other added it, or this side deleted it.
        const [side, value] = inOurs ? ['ours', o[key]] : ['theirs', t[key]];
        if (!inBase) {
          values.set(key, value);
        } else if (!same(b[key], value)) {
          // Deleted on one side, changed on the other.
          conflicts.push({
            path: where,
            base: present(b[key]),
            ours: present(side === 'ours' ? value : undefined),
            theirs: present(side === 'theirs' ? value : undefined),
          });
          values.set(key, value);
        }
        // Otherwise one side deleted a key the other left alone: drop it.
      }
    }
    const order = mergeKeyOrder(
      Object.keys(b),
      Object.keys(o),
      Object.keys(t),
      new Set(values.keys()),
    );
    return Object.fromEntries(order.map((key) => [key, values.get(key)]));
  }

  const value = mergeValue(base, ours, theirs, []);
  return { value, conflicts };
}

/**
 * `value` with every object's keys in the order of `references` (earlier
 * references win), and keys none of them has placed after the key they follow
 * in `value`. No value changes; no key is added or dropped.
 */
export function restoreKeyOrder(value, references) {
  if (!isPlainObject(value)) return value;
  const refs = references.filter(isPlainObject);
  const keep = new Set(Object.keys(value));
  const order = [];
  const placed = new Set();
  for (const keys of [...refs.map((ref) => Object.keys(ref)), Object.keys(value)]) {
    placeAfterPredecessors(order, placed, keys, keep);
  }
  return Object.fromEntries(
    order.map((key) => [
      key,
      restoreKeyOrder(
        value[key],
        refs.map((ref) => ref[key]),
      ),
    ]),
  );
}

function withConflictSide(value, conflicts, side) {
  function replace(tree, [key, ...rest], choice) {
    return Object.fromEntries(
      Object.entries(tree).flatMap(([k, v]) => {
        if (k !== key) return [[k, v]];
        if (rest.length > 0) return [[k, replace(v, rest, choice)]];
        return choice.present ? [[k, choice.value]] : [];
      }),
    );
  }
  return conflicts.reduce((tree, conflict) => replace(tree, conflict.path, conflict[side]), value);
}

function gitMergeFile(texts, { labels, markerSize, conflictStyle }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-catalog-merge-'));
  try {
    const files = ['ours', 'base', 'theirs'].map((name, i) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, texts[i]);
      return file;
    });
    const style =
      conflictStyle === 'diff3' || conflictStyle === 'zdiff3' ? [`--${conflictStyle}`] : [];
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        `--marker-size=${markerSize}`,
        ...style,
        ...labels.flatMap((label) => ['-L', label]),
        ...files,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    // `git merge-file` exits with the number of conflicts; a negative count
    // (seen as > 127) or no status at all is a failure.
    if (result.error || result.status === null || result.status > 127) {
      throw new Error(`git merge-file failed: ${result.error?.message ?? result.stderr}`);
    }
    return { text: result.stdout, conflicts: result.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The merge driver's work on file contents. With no conflict the result is
 * canonical. With conflicts, each side is rendered as a whole catalog that
 * differs from the others only at the conflicting keys, and git's own text
 * merge draws the markers: the hunks cover those keys and nothing else, and
 * either side of every hunk is valid JSON.
 */
export function mergeCatalogTexts(
  baseText,
  oursText,
  theirsText,
  { labels = ['ours', 'base', 'theirs'], markerSize = 7, conflictStyle } = {},
) {
  const base = baseText.trim() === '' ? undefined : JSON.parse(baseText);
  const { value, conflicts } = mergeCatalogs(base, JSON.parse(oursText), JSON.parse(theirsText));
  if (conflicts.length === 0) return { text: serializeCatalog(value), conflicts };
  if (conflicts.some((conflict) => conflict.path.length === 0)) {
    throw new Error('the two sides disagree about the whole file');
  }
  const sides = ['ours', 'base', 'theirs'].map((side) =>
    serializeCatalog(withConflictSide(value, conflicts, side)),
  );
  return { text: gitMergeFile(sides, { labels, markerSize, conflictStyle }).text, conflicts };
}

function displayPath(at) {
  return at.length === 0 ? '<root>' : at.join('.');
}

function git(args) {
  return spawnSync('git', args, {
    cwd: webRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Fails loudly: a guard that compares against a typo must not pass. */
function verifyRevision(rev) {
  if (git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).status !== 0) {
    throw new Error(`unknown revision: ${rev}`);
  }
}

/** The catalog at `rev`, or `undefined` when the file did not exist there. */
function readAt(rev, file) {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: webRoot,
    encoding: 'utf8',
  }).trim();
  const spec = `${rev}:${path.relative(repoRoot, file).split(path.sep).join('/')}`;
  if (git(['cat-file', '-e', spec]).status !== 0) return undefined;
  return JSON.parse(git(['show', spec]).stdout);
}

function parseFlags(argv) {
  const flags = new Map();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    flags.set(match[1], [...(flags.get(match[1]) ?? []), match[2] ?? 'true']);
  }
  return flags;
}

function firstDifferentLine(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const index = left.findIndex((line, i) => line !== right[i]);
  return (index === -1 ? left.length : index) + 1;
}

function runCheck(flags) {
  const base = flags.get('base')?.at(-1);
  if (base) verifyRevision(base);
  let failed = false;
  let anyReordered = false;
  for (const file of catalogFiles) {
    const name = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    const canonical = serializeCatalog(value);
    const problems = [];
    if (text !== canonical) {
      problems.push(
        `  not canonical from line ${firstDifferentLine(text, canonical)}; ` +
          'run `node apps/web/scripts/i18n-catalogs.mjs format`',
      );
    }
    let reordered = 0;
    if (base) {
      const before = readAt(base, file);
      const changes = before === undefined ? [] : findKeyOrderChanges(before, value);
      reordered = changes.length;
      if (changes.length > 0) {
        problems.push(`  reorders ${changes.length} object(s) it shares with ${base}:`);
        for (const change of changes.slice(0, 10)) {
          problems.push(
            `    ${displayPath(change.path)}: position ${change.index + 1} of ${change.shared} ` +
              `holds "${change.actual}", ${base} has "${change.expected}"`,
          );
        }
        if (changes.length > 10) problems.push(`    … and ${changes.length - 10} more`);
      }
    }
    if (problems.length === 0) {
      console.log(`${name}: ok`);
      continue;
    }
    failed = true;
    anyReordered ||= reordered > 0;
    console.log([`${name}:`, ...problems].join('\n'));
  }
  if (anyReordered) {
    // In CI the base is the test merge's first parent; name the branch instead.
    const from = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : base;
    console.log(
      [
        '',
        'A catalog keeps the order its keys were added in. A merge or script that',
        'rebuilt it reordered keys. Repair it without changing a value:',
        `  node apps/web/scripts/i18n-catalogs.mjs restore-order --from=${from} [--from=<your branch before the merge>]`,
        'If the reorder is intentional (for example STARTER_PROMPTS changed order),',
        `label the pull request \`${REORDER_LABEL}\`.`,
      ].join('\n'),
    );
  }
  return failed ? 1 : 0;
}

function runFormat() {
  for (const file of catalogFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const canonical = serializeCatalog(JSON.parse(text));
    if (text !== canonical) fs.writeFileSync(file, canonical);
    console.log(`${path.basename(file)}: ${text === canonical ? 'unchanged' : 'formatted'}`);
  }
  return 0;
}

function runRestoreOrder(flags) {
  const revs = flags.get('from') ?? [];
  if (revs.length === 0) {
    console.error('restore-order needs at least one --from=<rev>');
    return 2;
  }
  for (const rev of revs) verifyRevision(rev);
  for (const file of catalogFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    const references = revs.map((rev) => readAt(rev, file)).filter((ref) => ref !== undefined);
    const restored = serializeCatalog(restoreKeyOrder(value, references));
    // Order is the only thing this command may change.
    if (!sameIgnoringOrder(JSON.parse(restored), value)) {
      throw new Error(`${path.basename(file)}: restoring the order changed a value`);
    }
    if (restored !== text) fs.writeFileSync(file, restored);
    console.log(`${path.basename(file)}: ${restored === text ? 'unchanged' : 'reordered'}`);
  }
  return 0;
}

// An unexpanded `%X` means an older git that does not pass conflict labels.
function label(value, fallback) {
  return !value || /^%[A-Z]$/.test(value) ? fallback : value;
}

function runMergeDriver(args) {
  const [basePath, oursPath, theirsPath, markerSize = '7', pathname = oursPath] = args;
  const labels = [label(args[6], 'ours'), label(args[5], 'base'), label(args[7], 'theirs')];
  const options = {
    labels,
    markerSize: Number.parseInt(markerSize, 10) || 7,
    conflictStyle: spawnSync('git', ['config', '--get', 'merge.conflictStyle'], {
      encoding: 'utf8',
    }).stdout.trim(),
  };
  const texts = [basePath, oursPath, theirsPath].map((file) => fs.readFileSync(file, 'utf8'));
  let merged;
  try {
    merged = mergeCatalogTexts(texts[0], texts[1], texts[2], options);
  } catch (error) {
    // Not JSON, or not mergeable key by key: git's line merge, exactly as
    // without this driver.
    console.error(`i18n-catalogs: ${pathname}: ${error.message}; falling back to a text merge`);
    const fallback = gitMergeFile([texts[1], texts[0], texts[2]], options);
    fs.writeFileSync(oursPath, fallback.text);
    return fallback.conflicts > 0 ? 1 : 0;
  }
  fs.writeFileSync(oursPath, merged.text);
  if (merged.conflicts.length > 0) {
    console.error(
      `i18n-catalogs: ${pathname}: ${merged.conflicts.length} key(s) changed on both sides: ` +
        merged.conflicts
          .slice(0, 5)
          .map((conflict) => displayPath(conflict.path))
          .join(', '),
    );
    return 1;
  }
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'check':
      return runCheck(parseFlags(rest));
    case 'format':
      return runFormat();
    case 'restore-order':
      return runRestoreOrder(parseFlags(rest));
    case 'merge-driver':
      return runMergeDriver(rest);
    default:
      console.error(
        'usage: i18n-catalogs.mjs check [--base=<rev>] | format | restore-order --from=<rev>... | merge-driver %O %A %B %L %P %S %X %Y',
      );
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`i18n-catalogs: ${error instanceof Error ? error.message : error}`);
    // Above 128 tells git the driver failed, which aborts the merge instead of
    // recording a conflict whose file still holds only our side.
    process.exitCode = 255;
  }
}
