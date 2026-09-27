import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `/projects` is the project selector — an explicit destination, never a
 * default landing.
 *
 * History: `/projects` was once a list, then (Task 21) a pure redirect to the
 * landing door, and this guard enforced zero navigation to it. On 2026-09-22 it
 * became the Slack-style selector (`features/workspace/project-selector/`),
 * because users with projects were pushed into the create form with no way to
 * pick one. The rule that survives: a DEFAULT landing (post-auth, `/`, desktop
 * launch, account switch) goes through the door (`PROJECT_LANDING_PATH`), which
 * decides between one obvious project and the selector (`decideDoor`). Only the
 * places below may name `/projects` directly, each because the user explicitly
 * asked to leave for the selector.
 */

const ALLOWED: Record<string, string> = {
  // The door itself: no single obvious project → the selector.
  'app/[locale]/(app)/projects/start/page.tsx': 'the landing door hands off to the selector',
  // `/new` → desktop Close: the user leaves the create form for the selector.
  'features/workspace/new/new-workspace-page.tsx': 'explicit exit from the create form',
};

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

describe('/projects is an explicit destination, never a default landing', () => {
  test('only the allowlisted exits navigate to /projects programmatically', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel in ALLOWED) continue;
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

describe('the allowlist stays honest', () => {
  test('every allowlisted file exists and still navigates to /projects', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      const navigates =
        NAV_PATTERNS.some((pattern) => source.split('\n').some((line) => pattern.test(line))) ||
        source.includes("withCurrentQuery('/projects')");
      expect({ rel, navigates }).toEqual({ rel, navigates: true });
    }
  });
});
