import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The live transcript path must not touch the IndexedDB mirror.
 *
 * The mirror painted a session before its sandbox woke, and it cost more than
 * it bought. Its write gate was structural (`transcriptSignature`: message
 * count, total part count, tail id), so the two changes that END a turn were
 * invisible to it: `time.completed` stamped on the tail, and the `error` an
 * abort stamps. A normal turn was rescued by accident — OpenCode appends a
 * `step-finish` part, which moves the part count — but a STOP appends no part
 * at all. The disk copy of a stopped thread therefore held an assistant
 * message with neither `time.completed` nor `error`, which `isOpenTurn` reads
 * as a turn that is still running: on the next cold paint the stopped turn
 * shimmered and every message after it dimmed to "Queued".
 *
 * STATIC, over the whole reachable import graph rather than one file, so the
 * mirror cannot be wired back in through a helper.
 */

const SRC_ROOT = resolve(import.meta.dir, '../..');
/** The mirror's read/write half. `deleteSessionFromIDB` / `clearSessionIDBCache`
 *  are the CLEANUP half and stay wired — they purge what earlier versions left
 *  on disk. */
const FORBIDDEN = ['saveSessionToIDB', 'loadSessionFromIDB', 'session-transcript-cache'];
/** Entry points that make up the live transcript path. */
const ENTRIES = ['react/use-session-sync.ts', 'react/use-session.ts'];

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function reachableFrom(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const next = resolveRelative(file, match[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** The named bindings an `import { … } from '…'` statement pulls in. */
function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[2];
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
    names.push(specifier);
  }
  return names;
}

test('the live transcript path never reads or writes the IndexedDB mirror', () => {
  const offenders: string[] = [];
  for (const entry of ENTRIES) {
    for (const [file, source] of reachableFrom(join(SRC_ROOT, entry))) {
      const relative = file.slice(SRC_ROOT.length + 1);
      // The mirror module DEFINES the read/write half and keeps doing so — it
      // is published API. What must not exist is anyone IMPORTING it.
      if (relative === 'browser/cache/idb-sync-cache.ts') continue;
      for (const name of importedNames(source)) {
        if (FORBIDDEN.some((banned) => name.includes(banned))) {
          offenders.push(`${relative} → ${name}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});
