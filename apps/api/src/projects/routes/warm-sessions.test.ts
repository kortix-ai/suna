/**
 * JAY-596 / T20 — "New Session" must never hand back the session the user
 * just left.
 *
 * SOURCE-LEVEL guard on the route's WIRING for `exclude_session_id`. Hermetic
 * (reads the file as text, no database) so it runs under the default
 * `bun test` gate (`scripts/test.sh`'s fake-env mode), same shape as
 * `../r1-provision-idempotency.test.ts`.
 *
 * The BEHAVIORAL proof — `findWarmProjectSession` actually skipping the
 * excluded id against a real Postgres — lives in
 * `../../__tests__/integration-warm-sessions-exclude.test.ts`, which needs a
 * live database and therefore runs under `scripts/test.sh integration`
 * (`pnpm --filter kortix-api run test integration` / the repo's
 * `pnpm test -- --domain access` style local-first runner), exactly like
 * every other DB-backed route test in this app.
 *
 * Root cause this whole change fixes: the reuse lookup matched ANY of the
 * caller's live warm sessions. `takeWarmSession` (apps/web) consumes the
 * ready session and, in the SAME tick, fires a replenish
 * `POST .../sessions/warm` — seconds before the first prompt drops
 * `metadata.warm` (`recordSessionActivity`). That replenish found the
 * JUST-TAKEN session and handed it straight back with `reused: true`, so the
 * client's next "New Session" click reused the previous conversation.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'warm-sessions.ts'), 'utf8');
// Slice from the POST /warm route registration to the deprecated
// /warm/claim route below it, so assertions never spuriously match the OTHER
// route's body handling.
const routeStart = source.indexOf("path: '/{projectId}/sessions/warm',");
const routeEnd = source.indexOf("path: '/{projectId}/sessions/warm/claim',");
const route = source.slice(routeStart, routeEnd);

describe('findWarmProjectSession is exported for the integration test', () => {
  test('the exported function declaration exists', () => {
    expect(source).toContain('export async function findWarmProjectSession(');
  });

  test('it accepts an optional excludeSessionId and applies it as a `ne` predicate', () => {
    const fn = source.slice(source.indexOf('export async function findWarmProjectSession('));
    expect(fn).toContain('excludeSessionId?: string | null');
    expect(fn).toContain('ne(projectSessions.sessionId, scope.excludeSessionId)');
  });
});

describe('POST /sessions/warm threads exclude_session_id into the reuse lookup', () => {
  test('the route file actually has both markers this guard relies on', () => {
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
  });

  test('the request schema declares exclude_session_id as an optional field', () => {
    expect(route).toContain('exclude_session_id: z.string().optional()');
  });

  test('the body is read and exclude_session_id normalized before the reuse lookup', () => {
    const bodyRead = route.indexOf('readBody(c)');
    const normalized = route.indexOf('normalizeString(body.exclude_session_id)');
    const lookup = route.indexOf('findWarmProjectSession(');
    expect(bodyRead).toBeGreaterThan(-1);
    expect(normalized).toBeGreaterThan(bodyRead);
    expect(lookup).toBeGreaterThan(normalized);
  });

  test('excludeSessionId is forwarded into the lookup call, not swallowed', () => {
    const lookup = route.indexOf('findWarmProjectSession(');
    const nextClosingBrace = route.indexOf('});', lookup);
    const call = route.slice(lookup, nextClosingBrace);
    expect(call).toContain('excludeSessionId');
  });

  test('reuse-vs-create is still the ONE branch on `existing` — no second, divergent exclusion check downstream', () => {
    // The exclusion must live entirely inside the lookup. A second
    // `sessionId === excludeSessionId` check after `findWarmProjectSession`
    // returns would be a parallel copy of the same rule, free to drift from it.
    expect(route).not.toMatch(/existing\.sessionId\s*===\s*excludeSessionId/);
    expect(route.match(/if \(existing\)/g) ?? []).toHaveLength(1);
  });
});
