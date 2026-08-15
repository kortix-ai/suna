/**
 * JAY-599 / T21 — POST /start drops the warm marker on adoption.
 *
 * SOURCE-LEVEL guard on the route's WIRING (hermetic, no database), same shape
 * as `warm-sessions.test.ts`'s guard on the sibling `/warm` route. The
 * BEHAVIORAL proof that `dropWarmSessionMarkerOnAdopt` actually clears
 * `metadata.warm` against a real Postgres row lives in
 * `../../__tests__/integration-warm-session-adopt.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'r8.ts'), 'utf8');
// Slice from the POST /start route registration to the /restart route right
// below it, so assertions never spuriously match a different route's body.
const routeStart = source.indexOf("path: '/{projectId}/sessions/{sessionId}/start',");
const routeEnd = source.indexOf("path: '/{projectId}/sessions/{sessionId}/restart',");
const route = source.slice(routeStart, routeEnd);

describe('POST /start drops the warm marker on adoption', () => {
  test('the route file actually has both markers this guard relies on', () => {
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
  });

  test('imports the marker-drop and the pure warm-metadata check', () => {
    expect(source).toContain("import { dropWarmSessionMarkerOnAdopt } from './warm-sessions'");
    expect(source).toContain("import { isWarmProjectSession } from '../lib/warm-sessions'");
  });

  test('the drop is gated on isWarmProjectSession(visible.row.metadata) — never unconditional', () => {
    expect(route).toContain('if (isWarmProjectSession(visible.row.metadata))');
    const gateIndex = route.indexOf('if (isWarmProjectSession(visible.row.metadata))');
    const gate = route.slice(gateIndex, route.indexOf('}', gateIndex) + 1);
    expect(gate).toContain('await dropWarmSessionMarkerOnAdopt(sessionId)');
  });

  test('the drop runs after loadVisibleSession resolves, before startSession provisions anything', () => {
    const loaded = route.indexOf('loadVisibleSession(');
    const dropped = route.indexOf('dropWarmSessionMarkerOnAdopt(sessionId)');
    const started = route.indexOf('await startSession({');
    expect(loaded).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(loaded);
    expect(started).toBeGreaterThan(dropped);
  });

  test("never stamps last_activity_at here — that stays recordSessionActivity's job on the turn path", () => {
    expect(route).not.toContain('recordSessionActivity');
    expect(route).not.toContain('last_activity_at');
  });
});
