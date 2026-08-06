import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The projects LIST must never be a default destination.
 *
 * `/projects` is a place the user chooses to visit. It is not where the app
 * drops them after signing in, after a flow completes, or when it does not know
 * where else to go — those all resolve to the latest project. This test is the
 * enforcement: it scans for programmatic navigation to the bare `/projects`
 * path and fails on anything not explicitly justified below.
 *
 * If you are adding a genuine user-chosen "show me all my projects" control,
 * add it to ALLOWED with the reason. If you are adding a default landing, use
 * `latestProjectPath()` (or `PROJECT_LANDING_PATH` when the account context just
 * changed and the remembered project would be stale) instead.
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

const ALLOWED = new Map<string, string>([
  [
    'app/(app)/projects/start/page.tsx',
    'Terminal case only: no project exists AND none may be created (member without PROJECT_CREATE, or the account the user just emptied). The list is the surface that explains that state.',
  ],
  [
    'features/layout/user-menu.tsx',
    'Explicit "Projects" menu item — the user asking for the list by name.',
  ],
  [
    'features/workspace/command-palette.tsx',
    'Explicit "Go to projects" command the user types.',
  ],
  [
    'components/projects/project-access-boundary.tsx',
    'Explicit escape button shown when the user cannot read THIS project; the list is the honest destination.',
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the projects list is never a default destination', () => {
  test('no unjustified programmatic navigation to /projects', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      for (const [lineNo, line] of source.split('\n').entries()) {
        if (NAV_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${rel}:${lineNo + 1}  ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every ALLOWED entry still exists and still navigates to the list', () => {
    // Keeps the allowlist honest: a stale entry would silently permit a future
    // default landing in a file that no longer has a deliberate one.
    for (const [rel] of ALLOWED) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      const hasNav = source
        .split('\n')
        .some((line) => NAV_PATTERNS.some((pattern) => pattern.test(line)));
      expect({ rel, hasNav }).toEqual({ rel, hasNav: true });
    }
  });
});
