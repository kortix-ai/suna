import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The client warm-session boundary.
 *
 * PR #6047 removed the browser's hand-rolled speculative create-and-claim and
 * left a tripwire banning the SDK's warm-session names from `apps/web/src`
 * entirely. The rule it protected is real: the browser must never hand-roll
 * speculative session creation, scattered across whatever component needs it.
 *
 * The index page now DOES warm a session, through the server-owned, idempotent
 * `POST /projects/:id/sessions/warm`. So the rule moves rather than vanishes:
 * the SDK's two governed warm calls live in exactly ONE module, and everything
 * else in the app goes through that module's `useWarmIndexSession` /
 * `claimWarmIndexSession`. A second file reaching for the SDK surface directly
 * is the regression this test exists to catch.
 *
 * `WARM_PROJECT_SESSIONS_ENABLED` stays banned outright — it is a dead flag
 * from the removed client implementation and there is no correct use of it.
 */

const WEB_SOURCE_ROOT = resolve(import.meta.dir, '../..');
const THIS_FILE = resolve(import.meta.path);

/** The ONE module allowed to call the SDK's warm-session surface. */
const WARM_SESSION_MODULES = ['hooks/projects/use-warm-index-session.ts'] as const;

/** Allowed in `WARM_SESSION_MODULES`, banned everywhere else. */
const GOVERNED_WARM_SESSION_CALLS = [
  'ensureWarmProjectSession',
  'claimWarmProjectSession',
] as const;

/** Banned everywhere, with no exception. */
const FORBIDDEN_WARM_SESSION_REFERENCES = ['WARM_PROJECT_SESSIONS_ENABLED'] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [path];
  });
}

function relative(path: string): string {
  return path.slice(WEB_SOURCE_ROOT.length + 1);
}

function scan(
  references: readonly string[],
  isAllowed: (relativePath: string) => boolean,
): string[] {
  return sourceFiles(WEB_SOURCE_ROOT).flatMap((path) => {
    if (path === THIS_FILE) return [];
    const relativePath = relative(path);
    if (isAllowed(relativePath)) return [];
    const source = readFileSync(path, 'utf8');
    return references
      .filter((reference) => source.includes(reference))
      .map((reference) => `${relativePath}: ${reference}`);
  });
}

describe('client warm-session architecture', () => {
  test('only the warm-index-session module calls the SDK warm surface', () => {
    const violations = scan(GOVERNED_WARM_SESSION_CALLS, (path) =>
      (WARM_SESSION_MODULES as readonly string[]).includes(path),
    );

    expect(violations).toEqual([]);
  });

  test('the allowed module actually exists and holds the calls', () => {
    for (const modulePath of WARM_SESSION_MODULES) {
      const source = readFileSync(resolve(WEB_SOURCE_ROOT, modulePath), 'utf8');
      for (const call of GOVERNED_WARM_SESSION_CALLS) {
        expect(source).toContain(call);
      }
    }
  });

  test('the dead warm-session feature flag is referenced nowhere', () => {
    const violations = scan(FORBIDDEN_WARM_SESSION_REFERENCES, () => false);

    expect(violations).toEqual([]);
  });
});
