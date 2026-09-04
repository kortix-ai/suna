/**
 * A session route must fetch its session row scoped to the project AND account
 * it just authorized the caller for.
 *
 * `session-log.ts` and `session-environment.ts` are the two route modules the
 * pi runtime added, and both authorized the caller against `:projectId` and
 * then selected the session row by `sessionId` ALONE. Authorization proved one
 * thing; the action was taken on another. A caller authorized on their own
 * project could pass any other project's session id and read/append its
 * transcript or boot its environment box.
 *
 * Both are pre-`loadProjectSessionRow` hand-rolled selects, so nothing typed
 * catches it — hence a source-level guard.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = join(import.meta.dir, '..', 'projects', 'routes');

const FILES = ['session-log.ts', 'session-environment.ts'] as const;

describe('pi session routes scope their session lookup', () => {
  for (const file of FILES) {
    const src = readFileSync(join(ROUTES, file), 'utf8');

    test(`${file} selects projectSessions with a projectId predicate`, () => {
      expect(src).toContain('eq(projectSessions.projectId, loaded.row.projectId)');
    });

    test(`${file} selects projectSessions with an accountId predicate`, () => {
      expect(src).toContain('eq(projectSessions.accountId, loaded.row.accountId)');
    });

    test(`${file} has no bare .where(eq(projectSessions.sessionId, ...)) select`, () => {
      // The exact shape the bug had: session id as the ONLY predicate.
      expect(src).not.toMatch(/\.where\(\s*eq\(projectSessions\.sessionId,[^)]*\)\s*\)/);
    });
  }
});
