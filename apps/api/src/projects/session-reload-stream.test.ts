import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routes = readFileSync(join(import.meta.dir, 'routes/session-config.ts'), 'utf8');
const reloadCore = readFileSync(join(import.meta.dir, 'lib/session-reload.ts'), 'utf8');

// The streamed reload is the LAST route in this module, so the slice runs to
// the next route declaration if one is ever added after it, else to the end.
function streamRouteSource(): string {
  const start = routes.indexOf("path: '/{projectId}/sessions/{sessionId}/reload-stream'");
  expect(start).toBeGreaterThan(-1);
  const next = routes.indexOf("    path: '/{projectId}", start + 1);
  return routes.slice(start, next === -1 ? routes.length : next);
}

describe('POST /projects/:projectId/sessions/:sessionId/reload-stream', () => {
  test('keeps the existing JSON route and adds a separate streamed route', () => {
    expect(routes).toContain("path: '/{projectId}/sessions/{sessionId}/reload'");
    expect(routes).toContain("path: '/{projectId}/sessions/{sessionId}/reload-stream'");
  });

  test('authorizes before opening the stream', () => {
    const source = streamRouteSource();
    const stream = source.indexOf('new ReadableStream(');
    expect(stream).toBeGreaterThan(-1);
    // Assert PRESENCE before ORDER. `indexOf` returns -1 for a call that is not
    // there at all, and -1 is less than any real index — so an ordering-only
    // assertion reports "authorized first" for a route with no gate whatsoever.
    for (const gate of ['assertProjectCapability(', 'mayChangeSessionModel(']) {
      const at = source.indexOf(gate);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(stream);
    }
  });

  test('forwards real core phases and always writes a terminal frame', () => {
    const source = streamRouteSource();
    expect(source).toContain("write({ type: 'phase', phase })");
    expect(source).toContain("write({ type: 'done', result:");
    expect(source).toContain("type: 'error'");
    expect(source).toContain('finally');
    expect(source).toContain('controller.close()');
  });

  test('the reload core reports each phase at the operation boundary', () => {
    const expected = [
      "onPhase?.('checking-session')",
      "onPhase?.('refreshing-workspace')",
      "onPhase?.('confirming-config')",
    ];
    for (const statement of expected) expect(reloadCore).toContain(statement);
    expect(reloadCore).toContain('onPhase: input.onPhase');
  });
});
