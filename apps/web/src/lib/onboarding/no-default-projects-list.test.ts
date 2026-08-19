import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The projects LIST must never be a destination — default OR explicit.
 *
 * `/projects` used to be a real list a user could choose to visit; the three
 * ALLOWED exceptions below (`user-menu.tsx` "Home", `command-palette.tsx`
 * post-account-switch, `project-access-boundary.tsx` "Back to projects")
 * existed because asking for it by name was honest. Task 21 turned `/projects`
 * into a pure redirect back to the landing door — there is no longer a list to
 * ask for — and Task 22 repointed all three to `latestProjectPath()` /
 * `PROJECT_LANDING_PATH`. The allowlist is retired along with them: this test
 * now enforces zero programmatic navigation to the bare `/projects` path, full
 * stop. If you are adding a default landing, use `latestProjectPath()` (or
 * `PROJECT_LANDING_PATH` when the account context just changed and the
 * remembered project would be stale) — never the bare string.
 */

const SRC = join(import.meta.dir, '..', '..');

/** Programmatic navigation to the bare list. */
// `(?:\w+\()?` also catches a single wrapping call — e.g.
// `router.replace(withCurrentQuery('/projects'))`. Without it, wrapping the
// literal is a silent escape hatch from this entire guard.
const NAV_PATTERNS = [
  /router\.(?:push|replace)\(\s*(?:\w+\(\s*)?['"`]\/projects['"`]/,
  /window\.location\.href\s*=\s*(?:\w+\(\s*)?['"`]\/projects['"`]/,
  /redirect\(\s*(?:\w+\(\s*)?['"`]\/projects['"`]/,
  /NextResponse\.redirect\(\s*new URL\(\s*['"`]\/projects['"`]/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the projects list is never a destination', () => {
  test('no programmatic navigation to /projects anywhere', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      const source = readFileSync(file, 'utf8');
      for (const [lineNo, line] of source.split('\n').entries()) {
        if (NAV_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${rel}:${lineNo + 1}  ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
