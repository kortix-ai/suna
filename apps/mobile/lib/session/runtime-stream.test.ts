import { describe, expect, test } from 'bun:test';
import type { RuntimeStreamSignal } from '@kortix/sdk/react';
import { createStreamSignalBridge } from './runtime-stream';
import type { StreamHealthEvent } from './live-updates';

function harness(foreground = true) {
  let now = 1_000;
  const health: StreamHealthEvent[] = [];
  const cues: string[] = [];
  const deferred: Array<() => void> = [];
  const bridge = createStreamSignalBridge({
    dispatch: (event) => health.push(event),
    playCue: (cue) => cues.push(cue.sound),
    isForeground: () => foreground,
    now: () => now,
    defer: (run) => {
      deferred.push(run);
      return () => {
        const index = deferred.indexOf(run);
        if (index >= 0) deferred.splice(index, 1);
      };
    },
  });
  const event = (type: string, properties: Record<string, unknown>): RuntimeStreamSignal =>
    ({ type: 'event', event: { type, properties } }) as unknown as RuntimeStreamSignal;
  return {
    bridge,
    health,
    cues,
    event,
    tick: (ms: number) => {
      now += ms;
    },
    flush: () => {
      for (const run of deferred.splice(0)) run();
    },
  };
}

describe('createStreamSignalBridge', () => {
  test('connection signals become stream-health events, with the last frame time on a loss', () => {
    const h = harness();
    h.bridge({ type: 'connecting' });
    h.bridge({ type: 'open' });
    h.tick(500);
    h.bridge(h.event('session.status', { sessionID: 's', status: { type: 'busy' } }));
    h.tick(100);
    h.bridge({ type: 'lost' });
    h.bridge({ type: 'parked' });
    expect(h.health).toEqual([
      { type: 'connecting', at: 1_000 },
      { type: 'open', at: 1_000 },
      { type: 'lost', at: 1_600, lastEventAt: 1_500 },
      { type: 'parked', at: 1_600, lastEventAt: 1_500 },
    ]);
  });

  test('a reply that completes on the live stream plays the completion cue once', () => {
    const h = harness();
    h.bridge(h.event('session.status', { sessionID: 's', status: { type: 'busy' } }));
    h.bridge(h.event('session.status', { sessionID: 's', status: { type: 'idle' } }));
    h.bridge(h.event('session.idle', { sessionID: 's' }));
    expect(h.cues).toEqual(['completion']);
  });

  test('no cue while the app is in the background', () => {
    const h = harness(false);
    h.bridge(h.event('session.status', { sessionID: 's', status: { type: 'busy' } }));
    h.bridge(h.event('session.idle', { sessionID: 's' }));
    expect(h.cues).toEqual([]);
  });

  test('a stream that closes for good reports stopped; turns it saw busy are forgotten', () => {
    const h = harness();
    h.bridge(h.event('session.status', { sessionID: 's', status: { type: 'busy' } }));
    h.bridge({ type: 'closed' });
    h.flush();
    expect(h.health).toEqual([{ type: 'stopped' }]);
    // The next stream never saw this turn start: its end is history, not news.
    h.bridge(h.event('session.idle', { sessionID: 's' }));
    expect(h.cues).toEqual([]);
  });

  test('a close followed at once by a new connection is a reconnect, not a stop', () => {
    const h = harness();
    h.bridge({ type: 'open' });
    h.bridge(h.event('session.status', { sessionID: 's', status: { type: 'busy' } }));
    h.tick(50);
    // A manual Reconnect, or the app returning: the SDK closes and re-opens.
    h.bridge({ type: 'closed' });
    h.bridge({ type: 'connecting' });
    h.flush();
    expect(h.health).toEqual([
      { type: 'open', at: 1_000 },
      { type: 'lost', at: 1_050, lastEventAt: 1_000 },
      { type: 'connecting', at: 1_050 },
    ]);
    // Same turn, still tracked: its end on the new connection is news.
    h.bridge(h.event('session.idle', { sessionID: 's' }));
    expect(h.cues).toEqual(['completion']);
  });
});
