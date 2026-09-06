/**
 * A PI SESSION IS A CELL, AND A CELL'S CREATE BODY IS NOT A MICROVM'S.
 *
 * Two differences carry the whole thing. The runtime is `cell` with a worker
 * name, because Platinum refuses a worker-less cell as malformed (400
 * worker_required). And every session variable is prefixed `CELLD_VAR_`,
 * because celld passes exactly those into the isolate — an unprefixed variable
 * reaches the node and never the worker, which surfaces as an agent that booted
 * with no configuration at all rather than as an error.
 *
 * The port matters for the same reason: a cell's worker listens on 8080 while
 * the microVM agent listens on 8000, so a body that says 8000 exposes a port
 * nothing serves.
 *
 * Why this is worth a session's while (measured on dev 2026-09-06): a microVM
 * session reaches ready in 8-12 s; a celld node costs 3.3 s once and each
 * session after it is an isolate — 340-570 ms to spawn, 415-745 ms for a full
 * scripted turn, against a 186 ms round trip to the region.
 */
import { describe, expect, test } from 'bun:test';
import {
  CELL_PORT,
  CELL_TEMPLATE,
  CELL_WORKER_NAME,
  buildCellCreateBody,
} from './platinum';

const body = (over: Partial<Parameters<typeof buildCellCreateBody>[0]> = {}) =>
  buildCellCreateBody({
    name: 'kortix-9a8f94a3-65eb-4a5a-93e9-05d88a289f98-a1',
    envVars: { KORTIX_TOKEN: 'tok', KORTIX_API_URL: 'https://pi-js.kortix.com/v1' },
    ...over,
  }) as Record<string, any>;

describe('the create body for a session that runs as a cell', () => {
  test('names the cell runtime and a worker — Platinum refuses a worker-less cell', () => {
    const b = body();
    expect(b.runtime).toBe('cell');
    expect(b.worker).toBe(CELL_WORKER_NAME);
    expect(b.template).toBe(CELL_TEMPLATE);
  });

  test('every session variable is prefixed CELLD_VAR_, because that is what reaches the isolate', () => {
    const b = body();
    expect(b.env).toEqual({
      CELLD_VAR_KORTIX_TOKEN: 'tok',
      CELLD_VAR_KORTIX_API_URL: 'https://pi-js.kortix.com/v1',
    });
    // Nothing unprefixed survives: an unprefixed variable would reach the node
    // and never the worker, which looks like an agent with no configuration.
    expect(Object.keys(b.env).some((k) => !k.startsWith('CELLD_VAR_'))).toBe(false);
  });

  test('opens the port the cell\'s worker listens on, under `expose`', () => {
    const b = body();
    expect(b.expose).toEqual([{ port: CELL_PORT, public: true }]);
    expect(CELL_PORT).toBe(8080);          // not the microVM agent's 8000
    // `exposed_ports` is refused by the create route; using it would open none.
    expect(b.exposed_ports).toBeUndefined();
  });

  test('carries the session name and the managed metadata a reaper reads', () => {
    const b = body({ name: 'kortix-abc-a0' });
    expect(b.name).toBe('kortix-abc-a0');
    expect(b.metadata['kortix.managed']).toBe('true');
    expect(b.metadata['kortix.runtime']).toBe('cell');
  });

  test('passes size only when the caller asked for one', () => {
    expect(body().cpu).toBeUndefined();
    expect(body().ram_mb).toBeUndefined();
    const sized = body({ cpu: 2, ramMb: 4096 });
    expect(sized.cpu).toBe(2);
    expect(sized.ram_mb).toBe(4096);
  });

  test('an empty env is still an object — a cell with no variables is legal', () => {
    expect(body({ envVars: {} }).env).toEqual({});
  });

  test('values are stringified: a number in the env would be rejected by the API', () => {
    const b = buildCellCreateBody({ name: 'n', envVars: { PORT: 8080 as unknown as string } }) as Record<string, any>;
    expect(b.env.CELLD_VAR_PORT).toBe('8080');
    expect(typeof b.env.CELLD_VAR_PORT).toBe('string');
  });
});
