import { describe, expect, test } from 'bun:test';

import { showsGeneratingIndicator } from './working-indicator';
import type { WorkingProjection } from './working';

const idle: WorkingProjection = {
  state: 'idle',
  source: 'server',
  turnId: null,
  since: 0,
  serverOpenTurnToken: null,
};

const workingFrom = (source: WorkingProjection['source']): WorkingProjection => ({
  state: 'working',
  source,
  turnId: 'msg-1',
  since: 1_000,
  serverOpenTurnToken: 'tok-1',
});

/**
 * Reported 2026-08-29 on `pi-worker`: entering a session paints "Gathering
 * thoughts…" for ~30s over a transcript that is already fully rendered and a
 * turn that is not running, then it clears on its own.
 *
 * The evidence behind that claim is a `GET .../turn` read alone — the control
 * plane still holding a row open for a turn nobody is running. The session
 * stream has attached and PROMISED to carry turn state
 * (`kortix.control.turn`), but frames are pushed ON CHANGE, so a session
 * resumed with a row already open produces no frame and nothing contradicts
 * the stale read until it ages out.
 *
 * `workingRefetchInterval` already applies exactly this rule to the POLL — it
 * refuses to stand down on a connected-but-uncorroborated stream. This applies
 * the same rule to what the user SEES, which is the half that was missing.
 */
describe('showsGeneratingIndicator', () => {
  test('idle never shows it', () => {
    expect(
      showsGeneratingIndicator({ projection: idle, streamConnected: true, streamCorroborated: true }),
    ).toBe(false);
  });

  test('THE BUG: a server-only claim on a connected but uncorroborated stream is withheld', () => {
    expect(
      showsGeneratingIndicator({
        projection: workingFrom('server'),
        streamConnected: true,
        streamCorroborated: false,
      }),
    ).toBe(false);
  });

  test('the same claim shows once the stream corroborates it', () => {
    expect(
      showsGeneratingIndicator({
        projection: workingFrom('server'),
        streamConnected: true,
        streamCorroborated: true,
      }),
    ).toBe(true);
  });

  test('with NO stream attached the server read is all there is, so it decides', () => {
    // Never gate on a promise nobody made. A surface with no stream (or one
    // whose stream dropped) must not go permanently quiet over a real turn.
    expect(
      showsGeneratingIndicator({
        projection: workingFrom('server'),
        streamConnected: false,
        streamCorroborated: false,
      }),
    ).toBe(true);
  });

  test('stream and optimistic evidence are never withheld', () => {
    // `stream` is the runtime's own voice and `optimistic` is this tab's own
    // send — neither is the stale-row case, and delaying either would put a
    // visible lag on the thing the user just did.
    for (const source of ['stream', 'optimistic'] as const) {
      expect(
        showsGeneratingIndicator({
          projection: workingFrom(source),
          streamConnected: true,
          streamCorroborated: false,
        }),
      ).toBe(true);
    }
  });

  test('an absent corroboration flag is treated as corroborated', () => {
    // Older callers must not lose their indicator: the gate may only ever
    // withhold on a POSITIVE "the stream has not answered yet".
    expect(
      showsGeneratingIndicator({ projection: workingFrom('server'), streamConnected: true }),
    ).toBe(true);
  });
});
