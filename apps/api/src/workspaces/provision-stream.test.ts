/**
 * Source-level guards on `POST /v1/projects/provision-stream`
 * (`routes/r1.ts`) — the SSE sibling of `POST /provision`. Reads the file as
 * text, same shape as `routes/r1-provision-idempotency.test.ts` and
 * `provision-core.test.ts`. No database, no GitHub, no `mock.module` (which
 * is process-wide in this app and leaks into sibling suites).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routes = readFileSync(join(import.meta.dir, 'routes/r1.ts'), 'utf8');

/** The stream route's own block, bounded by the next route after it in the
 * file (`/{workspaceId}/git-token`, unmodified by this task). Slicing keeps the
 * ordering assertions below from accidentally matching an unrelated route
 * elsewhere in this 900+ line file. */
function streamRouteSource(): string {
  const start = routes.indexOf("path: '/provision-stream'");
  expect(start).toBeGreaterThan(-1);
  const end = routes.indexOf("path: '/{workspaceId}/git-token'", start);
  expect(end).toBeGreaterThan(start);
  return routes.slice(start, end);
}

/**
 * Source with comments removed, for assertions that must see only real code
 * — the surrounding comments legitimately DISCUSS `hono/streaming` and
 * `event:` framing (explaining what this route deliberately does NOT do),
 * so a raw substring check over the full text would fail on its own
 * documentation. Same helper shape as
 * `r1-provision-idempotency.test.ts`'s `codeOnly`.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('POST /provision-stream', () => {
  test('the route exists', () => {
    expect(routes).toContain("path: '/provision-stream'");
  });

  test('the JSON /provision route is untouched — the CLI and SDK depend on it', () => {
    expect(routes).toContain("path: '/provision'");
  });

  test('both routes go through the one shared core', () => {
    const coreCalls = routes.split('runProvision(').length - 1;
    expect(coreCalls).toBe(2);
  });

  test('the stream emits a terminal event on failure, never just closes', () => {
    expect(routes).toContain("type: 'error'");
    expect(routes).toContain("type: 'done'");
  });

  test('does not introduce hono/streaming as a second SSE style', () => {
    // `hono/streaming` is used nowhere else in apps/api. Checked against
    // CODE ONLY — the file's own comments legitimately name
    // `hono/streaming`/`streamSSE` while explaining why this route doesn't
    // use them, so a raw substring check would fail on that documentation.
    const code = codeOnly(routes);
    expect(code).not.toContain('hono/streaming');
    expect(code).not.toContain('streamSSE');
  });

  test('frames are data-only — no event: line duplicating the type discriminator', () => {
    // The tunnel SSE route's framing (`event: ${event}\ndata: ...`) is the
    // pattern this route deliberately does NOT copy — every payload already
    // carries `type`, and an `event:` line would duplicate that in a second
    // place that can drift. Checked against CODE ONLY — comments here
    // legitimately mention "`event:` line" while explaining that choice.
    const streamRoute = codeOnly(streamRouteSource());
    expect(streamRoute).not.toMatch(/event:\s*\$\{/);
    expect(streamRoute).not.toMatch(/`event:/);
  });

  test('the writer comment explains the type field is the sole discriminator', () => {
    const streamRoute = streamRouteSource();
    expect(streamRoute).toContain('discriminator');
  });

  test('authorization happens before the ReadableStream opens — a 403 is plain JSON, never inside the stream', () => {
    const streamRoute = streamRouteSource();
    const authorizeIdx = streamRoute.indexOf('authorize(');
    const streamIdx = streamRoute.indexOf('new ReadableStream(');
    expect(authorizeIdx).toBeGreaterThan(-1);
    expect(streamIdx).toBeGreaterThan(-1);
    expect(authorizeIdx).toBeLessThan(streamIdx);
    // And the 403 itself is a plain c.json, not a write() into the stream.
    expect(streamRoute.slice(authorizeIdx, streamIdx)).toContain('c.json({ error:');
  });

  test('a thrown exception inside runProvision still reaches a terminal error frame (try/catch around the call)', () => {
    const streamRoute = streamRouteSource();
    const tryIdx = streamRoute.indexOf('try {');
    const runProvisionIdx = streamRoute.indexOf('runProvision(', tryIdx);
    const catchIdx = streamRoute.indexOf('} catch', runProvisionIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(runProvisionIdx).toBeGreaterThan(tryIdx);
    expect(catchIdx).toBeGreaterThan(runProvisionIdx);
    expect(streamRoute.indexOf("type: 'error'", catchIdx)).toBeGreaterThan(catchIdx);
  });

  test('the controller always closes via finally, not only on the happy path', () => {
    const streamRoute = streamRouteSource();
    const finallyIdx = streamRoute.indexOf('finally');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(streamRoute.indexOf('controller.close(', finallyIdx)).toBeGreaterThan(finallyIdx);
  });

  test('the emit phases are forwarded as { type: "phase", phase } frames', () => {
    const streamRoute = streamRouteSource();
    expect(streamRoute).toContain("write({ type: 'phase', phase })");
  });

  test('a successful result carries the workspace body under "done"', () => {
    const streamRoute = streamRouteSource();
    const doneIdx = streamRoute.indexOf("type: 'done'");
    expect(doneIdx).toBeGreaterThan(-1);
    expect(streamRoute.slice(doneIdx, doneIdx + 70)).toContain('workspace: result.body');
  });

  // Final-review FIX 1: the error frame used to spread ONLY `result.body`
  // (`{ error, code? }`) — never `result.status`. `provisionWorkspaceStream`
  // (`packages/sdk/.../projects.ts`) throws whatever this frame carries, and
  // `apps/web`'s `messageFor`/`isRetryableError` classify every create
  // failure by reading `.status` — so a 400 and a 409 were indistinguishable
  // on this transport even though `runProvision` returns a distinct
  // `ProvisionResultStatus` for each. `errorIdx` finds the FIRST `type:
  // 'error'` in the route's source, which is this expected-failure branch
  // (the retry-loop's `catch` writes a SECOND, later `type: 'error'` frame
  // for a thrown exception, with no `result` in scope to read a status from).
  test('FIX 1: the error frame carries the result status, not just error/code', () => {
    const streamRoute = codeOnly(streamRouteSource());
    const errorIdx = streamRoute.indexOf("type: 'error'");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(streamRoute.slice(errorIdx, errorIdx + 80)).toContain('status: result.status');
  });
});
