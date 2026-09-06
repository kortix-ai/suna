// A PARK IS THE SAME THING THE SESSION WOULD HAVE MADE.
//
// A claimed park BECOMES the session's box, so whatever the park is, the
// session gets — the cell create path never runs for a session that wins a
// claim. The pool parked microVMs from the pi-worker template while sessions
// were meant to run as cells, and it opened its port with `exposed_ports`,
// which is the read-only field a row reports and the create route ignores
// (Platinum answers 400 for it now: kortix-ai/platinum#924). So every park had
// no port open and the claim POST could not reach it.
//
// Measured on dev 2026-09-06, session 4b61bea9: it claimed a parked microVM,
// then sat in `open-session:starting` for 173 s and finished with
// `runtime-asset refresh not delivered / unreachable`.
//
// These claims pin the park body to the cell body, so the two cannot drift.
import { describe, expect, test } from 'bun:test';
import { CELL_PORT, CELL_TEMPLATE, CELL_WORKER_NAME, buildCellCreateBody } from '../providers/platinum';
import { claimUrl, claimedBaseUrl, newParkToken, parkName } from './pi-worker-pool-platinum';

// The body createParked builds, reproduced from the same helper it calls.
const parkBody = () => buildCellCreateBody({
  name: parkName('aabbccdd1122', newParkToken()),
  envVars: { KORTIX_PI_PARK: '1', KORTIX_SERVICE_PORT: String(CELL_PORT) },
  metadata: { 'kortix.piworker-park': '1' },
}) as Record<string, any>;

describe('the body a park is created with', () => {
  test('names the cell runtime and worker — a park a session inherits must BE a cell', () => {
    const b = parkBody();
    expect(b.runtime).toBe('cell');
    expect(b.worker).toBe(CELL_WORKER_NAME);
    expect(b.template).toBe(CELL_TEMPLATE);
  });

  test('opens its port with `expose` — `exposed_ports` opens none at all', () => {
    const b = parkBody();
    expect(b.expose).toEqual([{ port: CELL_PORT, public: true }]);
    expect(b.exposed_ports).toBeUndefined();
    expect(b.ports).toBeUndefined();
  });

  test('the park token reaches the ISOLATE, so the claim can be authenticated', () => {
    // Unprefixed, it would reach the celld node and never the worker that has
    // to compare it against the x-park-token header.
    const b = parkBody();
    expect(b.env.CELLD_VAR_KORTIX_PI_PARK).toBe('1');
    expect(Object.keys(b.env).every((k) => k.startsWith('CELLD_VAR_'))).toBe(true);
  });

  test('and it is still findable as a park — the name carries the registry', () => {
    expect(parkBody().name.startsWith('pi-park-')).toBe(true);
    expect(parkBody().metadata['kortix.piworker-park']).toBe('1');
    expect(parkBody().metadata['kortix.managed']).toBe('true');
  });
});

describe('the claim reaches the port the park opened', () => {
  test('claim and base URLs use the cell port, not the microVM agent port', () => {
    expect(claimUrl('sbx_p')).toContain(`/${CELL_PORT}/`);
    expect(claimedBaseUrl('sbx_p')).toEndWith(`/${CELL_PORT}`);
    expect(claimUrl('sbx_p')).not.toContain('/8000/');
  });
});
