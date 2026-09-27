/**
 * GET /:projectId/llm-catalog/providers returned the full runtime model
 * catalog (7.3MB seed, ~4.5MB gzipped) with no HTTP caching on every call,
 * even though the body is 100% project-independent — only the auth check
 * uses `projectId`. Every consumer (apps/web) already sets a 1h React Query
 * `staleTime` on this call, so a repeat within that window was previously a
 * full re-transfer anyway.
 *
 * Fix: derive a weak ETag from the runtime catalog's own `revision` counter
 * (only advances on an actual models.dev refresh, so it is cheap and exact)
 * and add `Cache-Control: private, max-age=3600` so the browser's HTTP cache
 * can skip the network round trip for an hour, and a revalidation after that
 * ends as a 304 with no body instead of re-sending the full catalog.
 *
 * Hermetic (reads the file as text, no database), same shape as
 * `./warm-sessions.test.ts` — the route always requires a project-scoped
 * auth check, so a full request-level test lives with the other DB-backed
 * route tests, not here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'models.ts'), 'utf8');
const routeStart = source.indexOf("path: '/{projectId}/llm-catalog/providers',");
const routeEnd = source.indexOf(
  '// ─── Default model preferences (account-scoped) ───',
);
const route = source.slice(routeStart, routeEnd);

describe('GET /:projectId/llm-catalog/providers caches the static catalog', () => {
  test('the route markers this guard relies on both exist', () => {
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
  });

  test('the ETag is derived from the runtime catalog revision, not the body', () => {
    expect(route).toContain('runtimeModelCatalog.status()');
    expect(route).toContain('status.revision');
    // Must not hash/stringify the full snapshot just to build the ETag.
    expect(route).not.toMatch(/etag[\s\S]{0,80}JSON\.stringify\(runtimeModelCatalog\.snapshot/i);
  });

  test('sets a private, hour-long Cache-Control so repeats skip the network', () => {
    expect(route).toContain("c.header('Cache-Control', 'private, max-age=3600')");
  });

  test('honors If-None-Match with a bare 304, not a re-transfer', () => {
    expect(route).toContain("c.req.header('if-none-match') === etag");
    expect(route).toContain('c.body(null, 304)');
  });

  test('still serves the full snapshot on a genuine miss', () => {
    expect(route).toContain('JSON.stringify(runtimeModelCatalog.snapshot())');
  });

  test('the 304 status is declared in the OpenAPI contract', () => {
    expect(route).toContain('304: {');
  });
});
