import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `ended_at` is what every reader treats as "closed forever":
// getOpenComputeSession keys off `IS NULL`, the usage rollup coalesces to it,
// and the reimburse script bounds refunds by it. Two independent writers is how
// a window gets settled to one instant and stamped with another.
describe('the sandbox_compute_sessions.ended_at single-writer invariant', () => {
  const API_SRC = join(import.meta.dir, '..', '..');
  const OWNER = 'billing/repositories/compute-sessions.ts';

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        sourceFiles(full, out);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        out.push(full);
      }
    }
    return out;
  }

  // `endedAt:` is a proxy for "assigns this column", and the bare string also
  // appears in code that has nothing to do with compute sessions — a drizzle
  // SELECT projection on another table with an `ended_at` column reads
  // `endedAt: someTable.endedAt` (kortix.session_turns has one). Scope the scan
  // to modules that could write THIS column: composing that statement means
  // naming the table, through the drizzle symbol or in raw SQL.
  const NAMES_COMPUTE_SESSIONS = /sandboxComputeSessions|sandbox_compute_sessions/;

  test('exactly one module assigns sandbox_compute_sessions.ended_at', () => {
    const scanned = sourceFiles(API_SRC).map((file) => ({
      file: file.slice(API_SRC.length + 1).split('\\').join('/'),
      src: readFileSync(file, 'utf8'),
    }));
    // The scope must admit the owner, or the scan below counts zero everywhere.
    const owner = scanned.find((entry) => entry.file === OWNER);
    expect(owner && NAMES_COMPUTE_SESSIONS.test(owner.src)).toBe(true);

    const writers = scanned
      .filter((entry) => NAMES_COMPUTE_SESSIONS.test(entry.src))
      .filter((entry) => /endedAt:\s/.test(entry.src))
      .map((entry) => entry.file);

    expect(writers).toEqual([OWNER]);
  });
});
