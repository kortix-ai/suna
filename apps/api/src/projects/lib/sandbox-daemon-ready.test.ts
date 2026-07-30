// A managed-ACP session never runs the opencode HTTP server: the daemon reports
// `opencode: 'down'` for its whole life. The prompt path used to wait whenever
// the state was merely NOT 'ok', so every single ACP prompt burned the full
// 18s readiness budget waiting for a process that is deliberately never going
// to start — measured at 20-24s of dead time per turn on session
// fcfd1f38-5e64-4a65-9db1-78cb5a6a4690 (a 3-token answer took 27-30s end to
// end, of which ~5s was the actual LLM call).
//
// The wait exists for ONE reason: a model-affecting env change makes the daemon
// restart opencode, and the prompt must not be forwarded into that restart
// window. The daemon restarts opencode iff `refreshModels && (projectEnvChanged
// || opencodeEnvChanged)` (apps/kortix-sandbox-agent-server/src/routes/env.ts's
// `/kortix/env` handler) — so THAT predicate, not `state !== 'ok'`, is what
// decides whether there is anything to wait for.
import { describe, expect, test } from 'bun:test';

import { shouldWaitForOpencodeReady } from './sandbox-daemon-ready';

describe('shouldWaitForOpencodeReady', () => {
  test('managed-ACP steady state (opencode down, nothing changed): never waits', () => {
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: true,
        projectEnvChanged: false,
        opencodeEnvChanged: false,
        opencodeState: 'down',
      }),
    ).toBe(false);
  });

  test('an opencode session whose env change restarted the runtime: still waits', () => {
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: true,
        projectEnvChanged: true,
        opencodeEnvChanged: false,
        opencodeState: 'starting',
      }),
    ).toBe(true);
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: true,
        projectEnvChanged: false,
        opencodeEnvChanged: true,
        opencodeState: 'starting',
      }),
    ).toBe(true);
  });

  test('a restart the daemon reports as still down waits too (stop() sets down before start() runs)', () => {
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: true,
        projectEnvChanged: true,
        opencodeEnvChanged: false,
        opencodeState: 'down',
      }),
    ).toBe(true);
  });

  test('already serving: nothing to wait for even when the env changed', () => {
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: true,
        projectEnvChanged: true,
        opencodeEnvChanged: true,
        opencodeState: 'ok',
      }),
    ).toBe(false);
  });

  test('no model refresh requested: the daemon never restarts opencode, so never waits', () => {
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: false,
        projectEnvChanged: true,
        opencodeEnvChanged: true,
        opencodeState: 'down',
      }),
    ).toBe(false);
  });

  test('a cold-booting opencode waits even when no env changed', () => {
    expect(
      shouldWaitForOpencodeReady({
        refreshModels: true,
        projectEnvChanged: false,
        opencodeEnvChanged: false,
        opencodeState: 'starting',
      }),
    ).toBe(true);
  });

  test('an unknown/absent state never waits, so this stays a strict subset of the old condition', () => {
    for (const projectEnvChanged of [false, true]) {
      expect(
        shouldWaitForOpencodeReady({
          refreshModels: true,
          projectEnvChanged,
          opencodeEnvChanged: false,
          opencodeState: null,
        }),
      ).toBe(false);
    }
  });

  // The condition this replaced was `opencodeState && opencodeState !== 'ok'`.
  // Pin that the new predicate never waits where the old one did not — a
  // regression here would mean ADDING latency somewhere instead of removing it.
  test('never waits where the replaced condition would not have', () => {
    const states = ['ok', 'starting', 'down', 'weird', null] as const;
    for (const opencodeState of states) {
      for (const refreshModels of [false, true]) {
        for (const projectEnvChanged of [false, true]) {
          for (const opencodeEnvChanged of [false, true]) {
            const legacyWouldWait = Boolean(opencodeState) && opencodeState !== 'ok';
            const now = shouldWaitForOpencodeReady({
              refreshModels,
              projectEnvChanged,
              opencodeEnvChanged,
              opencodeState,
            });
            if (now) expect(legacyWouldWait).toBe(true);
          }
        }
      }
    }
  });
});
