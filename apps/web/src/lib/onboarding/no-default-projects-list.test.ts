import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The removed collection pages must never be navigation destinations.
 *
 * `/projects` used to be a real list a user could choose to visit; the three
 * ALLOWED exceptions below (`user-menu.tsx` "Home", `command-palette.tsx`
 * post-account-switch, `workspace-access-boundary.tsx` "Back to projects")
 * existed because asking for it by name was honest. Task 21 turned `/projects`
 * into a pure redirect back to the landing door — there is no longer a list to
 * ask for — and Task 22 repointed all three to `latestWorkspacePath()` /
 * `WORKSPACE_LANDING_PATH`. The allowlist is retired along with them: this test
 * now enforces zero programmatic navigation to bare `/projects` or `/workspaces`
 * paths. If you are adding a default landing, use `latestWorkspacePath()` (or
 * `WORKSPACE_LANDING_PATH` when the account context just changed and the
 * remembered project would be stale) — never the bare string.
 */

const SRC = join(import.meta.dir, '..', '..');

/** Programmatic navigation to either bare compatibility collection path. */
// `(?:\w+\()?` also catches a single wrapping call — e.g.
// `router.replace(withCurrentQuery('/workspaces'))`. Without it, wrapping the
// literal is a silent escape hatch from this entire guard.
const NAV_PATTERNS = [
  /router\.(?:push|replace)\(\s*(?:\w+\(\s*)?['"`]\/(?:workspaces|projects)['"`]/,
  /window\.location\.href\s*=\s*(?:\w+\(\s*)?['"`]\/(?:workspaces|projects)['"`]/,
  /redirect\(\s*(?:\w+\(\s*)?['"`]\/(?:workspaces|projects)['"`]/,
  /NextResponse\.redirect\(\s*new URL\(\s*['"`]\/(?:workspaces|projects)['"`]/,
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

describe('removed workspace collection pages are never destinations', () => {
  test('no programmatic navigation to bare /projects or /workspaces', () => {
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
