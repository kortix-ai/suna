import { describe, expect, test } from 'bun:test';
import { projectWorking, type SessionTurn } from '@kortix/sdk';

import { serverHoldsOpenTurn, sessionComposerReadiness } from './session-composer-readiness';

describe('sessionComposerReadiness', () => {
  test('a ready runtime leaves the composer alone — no notice', () => {
    expect(sessionComposerReadiness({ runtimeReady: true })).toEqual({
      ready: true,
      notice: null,
      retryable: false,
    });
  });

  test('a sleeping sandbox reports not-ready WITHOUT disabling anything', () => {
    // The behaviour change this file exists to pin. It used to return
    // `{ disabled: true }`, which produced a dead editor and a spinner where
    // the send button belongs — indistinguishable from a broken composer, and
    // for a stopped sandbox it never cleared on its own. The shape no longer
    // has a `disabled` field for a caller to reach for.
    const readiness = sessionComposerReadiness({ runtimeReady: false });

    expect(readiness.ready).toBe(false);
    expect('disabled' in readiness).toBe(false);
  });

  test('says what is happening AND what a send will do', () => {
    // Both halves matter: the send button stays live, so a notice that only
    // says "waking" leaves pressing it looking like nothing happened.
    const { notice } = sessionComposerReadiness({ runtimeReady: false });

    expect(notice).toMatch(/waking/i);
    expect(notice).toMatch(/queue/i);
  });

  test('the notice is null when ready, so the bar cannot render on a live session', () => {
    expect(sessionComposerReadiness({ runtimeReady: true }).notice).toBeNull();
  });

  // A session the CONTROL PLANE says is mid-turn is a session whose box is up —
  // that is what `working.source === 'server'` means. Saying "waking" over it is
  // a lie the user can disprove by watching the turn stream in front of them.
  test('a live server turn suppresses the waking notice', () => {
    const readiness = sessionComposerReadiness({ runtimeReady: false, serverTurnLive: true });

    expect(readiness.notice).toBeNull();
  });

  test('a live server turn does NOT claim the runtime is ready', () => {
    // `ready` drives whether a submit is a delivery or an inbox row. The probe
    // still has not answered, so it stays an inbox row — only the misleading
    // line goes away.
    expect(sessionComposerReadiness({ runtimeReady: false, serverTurnLive: true }).ready).toBe(
      false,
    );
  });

  test('no server turn leaves the notice exactly as it was', () => {
    expect(sessionComposerReadiness({ runtimeReady: false, serverTurnLive: false }).notice).toMatch(
      /waking/i,
    );
  });

  // Suppressing the waking notice must not leave the composer SILENT. An open
  // turn whose daemon has stopped answering is not a contradiction: the reaper
  // clears an unobservable turn record only once its deadline passes, and
  // `turnGrantMs()` defaults to 240 minutes — so `GET .../turn` keeps reporting
  // the turn for up to four hours while every probe fails. Without a notice of
  // its own the user gets a Stop button, sends that go nowhere, and nothing on
  // screen saying why.
  test('an open turn the runtime has stopped answering for says so', () => {
    const { notice, ready } = sessionComposerReadiness({
      runtimeReady: false,
      serverTurnLive: true,
      unreachable: true,
    });

    expect(ready).toBe(false);
    expect(notice).not.toBeNull();
    // NOT "waking" — nothing is booting; contact with a running turn was lost.
    expect(notice).not.toMatch(/waking/i);
    // Still says what a send does, for the same reason the waking notice does.
    expect(notice).toMatch(/queue/i);
  });

  test('an open turn on a runtime that has simply not answered YET stays quiet', () => {
    // The probe is slow, not failed — `sandboxStatus` is still `connecting`.
    // Saying anything here would be the lie this whole branch removed.
    expect(
      sessionComposerReadiness({
        runtimeReady: false,
        serverTurnLive: true,
        unreachable: false,
      }).notice,
    ).toBeNull();
  });

  test('an unreachable runtime with NO open turn reads as lost contact with a retry', () => {
    // Pre-merge this asserted the WAKING notice, on the theory that an
    // unreachable box with no turn is merely parked. Step 10's hop attribution
    // made that theory obsolete: a parked box answers with the control_plane
    // hop, which never counts toward the failure threshold, so `unreachable`
    // now always means the probes genuinely failed — and that state must offer
    // the reconnect escape hatch (#6509), never an unbounded "Waking…".
    const result = sessionComposerReadiness({
      runtimeReady: false,
      serverTurnLive: false,
      unreachable: true,
    });
    expect(result.notice).toMatch(/lost contact/i);
    expect(result.retryable).toBe(true);
  });
});

// WHICH field of the projection means "the box is up" — the one question the
// notice turns on. `source === 'server'` is NOT it: the projection reports that
// source for a durable inbox row too, and an inbox row is the state where
// nothing is running and the box may not even exist yet.
describe('serverHoldsOpenTurn', () => {
  function openTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
    return {
      turn_token: 'tok_live',
      state: 'active',
      message_id: 'msg_1',
      opencode_session_id: 'ses_1',
      started_at: new Date(1_000).toISOString(),
      accepted_at: null,
      ...overrides,
    };
  }

  test('an open turn the control plane is holding is proof the box is up', () => {
    const working = projectWorking({
      optimistic: null,
      server: { turns: [openTurn()], atMs: 1_000 },
      stream: null,
      nowMs: 1_500,
    });

    expect(working.state).toBe('working');
    expect(serverHoldsOpenTurn(working)).toBe(true);
    expect(sessionComposerReadiness({ runtimeReady: false, serverTurnLive: true }).notice).toBeNull();
  });

  test('a turn started with no wire messageID counts — triggers, Slack, and every `/` command', () => {
    // The class this predicate silently excluded. `postPrompt` sends no
    // `messageID` for a trigger, a Slack/Teams/Telegram delivery, an approval
    // resume or an email, and `buildSessionCommandInput` sends none for any `/`
    // command — so `GET .../turn` answers `message_id: null` while the turn
    // streams. Keyed on the message id, "does the control plane hold a turn"
    // answered NO for all of them, and the waking notice painted over a live
    // `/compact`.
    const working = projectWorking({
      optimistic: null,
      server: { turns: [openTurn({ message_id: null })], atMs: 1_000 },
      stream: null,
      nowMs: 1_500,
    });

    expect(working.state).toBe('working');
    expect(working.source).toBe('server');
    expect(serverHoldsOpenTurn(working)).toBe(true);
    expect(
      sessionComposerReadiness({
        runtimeReady: false,
        serverTurnLive: serverHoldsOpenTurn(working),
      }).notice,
    ).toBeNull();
  });

  test('a QUEUED inbox row is not an open turn, so the waking notice stays', () => {
    // The state the notice was written for: a parked box, one prompt POSTed and
    // accepted, and an 18.9s–24.5s resume ahead of it. `GET .../turn` honestly
    // reports no turns; the projection still says `source: 'server'` because
    // the durable row outranks an idle read. Reading `source` here removed the
    // one line explaining why nothing is happening, exactly when it was true.
    const working = projectWorking({
      optimistic: null,
      server: { turns: [], atMs: 1_000 },
      stream: null,
      inbox: { pending: 1, atMs: 1_000 },
      nowMs: 1_500,
    });

    expect(working.state).toBe('working');
    expect(working.source).toBe('server');
    expect(working.serverOpenTurnToken).toBeNull();
    expect(serverHoldsOpenTurn(working)).toBe(false);
    expect(
      sessionComposerReadiness({
        runtimeReady: false,
        serverTurnLive: serverHoldsOpenTurn(working),
      }).notice,
    ).toMatch(/waking/i);
  });

  test('a stream frame is not the control plane and cannot vouch for the box', () => {
    // A `busy` frame survives a box that died mid-turn — it is this tab's last
    // observation, not a live read. Only the control plane's turn authority is
    // husk-finalized when the box dies.
    const working = projectWorking({
      optimistic: null,
      server: null,
      stream: { type: 'busy', atMs: 1_000 },
      nowMs: 1_500,
    });

    expect(working.state).toBe('working');
    expect(serverHoldsOpenTurn(working)).toBe(false);
  });

  test('booting/connecting (not yet unreachable) is not retryable', () => {
    // The default — still within the poll loop's failure threshold. No
    // manual retry offered; the background poller is expected to resolve
    // this on its own shortly.
    const readiness = sessionComposerReadiness({ runtimeReady: false, unreachable: false });

    expect(readiness.retryable).toBe(false);
    expect(readiness.notice).toMatch(/waking/i);
  });

  test('confirmed unreachable offers a retry and says so, distinctly from "waking"', () => {
    // Past `FAIL_THRESHOLD_*` — `useRuntimePhase() === 'unreachable'`. Same
    // "not ready" bucket as a booting sandbox, but this one has been failing
    // for a while and the user needs to know an escape hatch exists instead
    // of staring at an unchanging "waking up" forever. See `retryable`'s doc.
    const readiness = sessionComposerReadiness({ runtimeReady: false, unreachable: true });

    expect(readiness.ready).toBe(false);
    expect(readiness.retryable).toBe(true);
    expect(readiness.notice).not.toMatch(/waking/i);
    expect(readiness.notice).toMatch(/queue/i);
  });

  test('stalled (booting past the ceiling, never unreachable) also offers a retry', () => {
    // The gap `unreachable` alone can't cover: a sandbox proxy that keeps
    // answering 503 resets the probe's failure counter every tick, so
    // `unreachable` never fires no matter how long OpenCode stays wedged
    // mid-boot. `useRuntimeBootStalled()` is the only thing that still bounds
    // that case — see its doc and `bootingSinceAt` on the connection store.
    const readiness = sessionComposerReadiness({ runtimeReady: false, stalled: true });

    expect(readiness.ready).toBe(false);
    expect(readiness.retryable).toBe(true);
    expect(readiness.notice).toMatch(/queue/i);
  });

  test('unreachable is checked before stalled — its notice wins when both are true', () => {
    const readiness = sessionComposerReadiness({
      runtimeReady: false,
      unreachable: true,
      stalled: true,
    });

    expect(readiness.notice).toMatch(/lost contact/i);
  });
});
