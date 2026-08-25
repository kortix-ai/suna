/**
 * The stop-reason catalogue exists twice, and this is what stops the two
 * copies from disagreeing.
 *
 * `@kortix/api-contract` owns it; `apps/api/src/projects/stop-reason.ts`
 * re-exports that, so the server cannot drift by construction. The SDK is the
 * copy: it ships to browsers and declares exactly one Kortix dependency
 * (`@kortix/llm-catalog`), so it cannot import the contract package without
 * pulling zod and the whole server contract into every web bundle. A hand
 * mirror plus this test was the cheaper trade.
 *
 * What drift would cost: the server starts serializing a reason the client's
 * union does not contain, the client's exhaustive copy map silently has no
 * entry for it, and a user gets an unexplained "stopped" — which is the exact
 * failure this whole field was added to end. That is invisible in review and
 * invisible at runtime, so it is pinned here instead.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STOP_REASONS } from './stop-reason';

const SDK_SOURCE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'sdk',
  'src',
  'core',
  'rest',
  'projects-client',
  'session-sandbox.ts',
);

/** The members of the SDK's `STOP_REASONS` literal, read from source. */
function sdkStopReasons(): string[] {
  const source = readFileSync(SDK_SOURCE, 'utf8');
  const start = source.indexOf('export const STOP_REASONS = [');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('] as const;', start);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe('stop-reason catalogue parity', () => {
  test('the SDK literal was found and is not accidentally empty', () => {
    // Guards the reader itself: a rename in the SDK would otherwise make every
    // assertion below vacuously compare two empty lists.
    expect(sdkStopReasons().length).toBeGreaterThan(5);
  });

  test('the SDK lists exactly the contract members, in the same order', () => {
    // Order too, not just membership: both are `as const` tuples, and a client
    // rendering the catalogue in declaration order should not depend on which
    // copy it read.
    expect(sdkStopReasons()).toEqual([...STOP_REASONS]);
  });

  test('the server re-exports the contract catalogue rather than redeclaring it', () => {
    const serverSource = readFileSync(join(import.meta.dir, 'stop-reason.ts'), 'utf8');
    expect(serverSource).toContain("from '@kortix/api-contract'");
    // A second `export const STOP_REASONS = [` here would mean the re-export
    // was quietly replaced by a local copy — one more thing to drift.
    expect(serverSource).not.toContain('export const STOP_REASONS = [');
  });
});
