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

  test('the ROUTE never calls recordSessionActivity — turn stamping stays on the prompt path', () => {
    expect(route).not.toContain('recordSessionActivity');
  });

  // REVERSAL of the earlier "adoption never stamps activity" pin, on purpose:
  // adoption only ever happens because a user pressed Enter with a prompt (the
  // warm take navigates and fires /start), so "last active" = adoption time is
  // honest — while the old behavior sorted the just-started session at its
  // CREATE time (the start of the user's dwell on the project home), burying
  // the newest session in the sidebar until the first prompt round-tripped.
  // The stamp lives INSIDE dropWarmSessionMarkerOnAdopt, in the same UPDATE
  // that drops the marker, so "used" and "last active" stay one write.
  test('the drop helper stamps last_activity_at in the same statement as the marker drop', () => {
    const helperSource = readFileSync(
      join(import.meta.dir, 'warm-sessions.ts'),
      'utf8',
    );
    const helperStart = helperSource.indexOf('export async function dropWarmSessionMarkerOnAdopt');
    const helperEnd = helperSource.indexOf('function warmSessionUnavailable');
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = helperSource.slice(helperStart, helperEnd);
    expect(helper).toContain('SESSION_LAST_ACTIVITY_KEY');
    expect(helper).toContain('projectSessionMetadataMerge');
  });

  // Second half of the same reversal: `GET /sessions` orders by
  // `updated_at DESC` (routes/project-sessions.ts), so an adoption that only
  // stamped metadata left every API-order consumer — CLI `sessions list`,
  // mobile, external SDK users — reporting a stale "latest session" until the
  // first prompt's `recordSessionActivity` caught up. Adoption now stamps
  // `updatedAt` too, exactly like `recordSessionActivity` does.
  test('the drop helper bumps updatedAt so API-order consumers see the adopted session as newest', () => {
    const helperSource = readFileSync(join(import.meta.dir, 'warm-sessions.ts'), 'utf8');
    const helperStart = helperSource.indexOf('export async function dropWarmSessionMarkerOnAdopt');
    const helperEnd = helperSource.indexOf('function warmSessionUnavailable');
    const helper = helperSource.slice(helperStart, helperEnd);
    expect(helper).toContain('updatedAt');
  });
});
