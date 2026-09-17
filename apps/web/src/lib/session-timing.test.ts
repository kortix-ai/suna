import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  FIRST_OUTPUT_MARK,
  beginSessionTiming,
  clearSessionClick,
  markSessionClick,
  markSessionFirstOutput,
  sendToFirstOutputMs,
  sessionMark,
} from './session-timing';

describe('sendToFirstOutputMs', () => {
  test('measures the first-output mark from the send press', () => {
    expect(
      sendToFirstOutputMs({
        sendStartedAt: 1_000,
        entries: [
          { label: 'server-switched', at: 1_400 },
          { label: FIRST_OUTPUT_MARK, at: 9_750 },
        ],
      }),
    ).toBe(8_750);
  });

  // The session page marks first output for every session it opens. Only a
  // session this tab SENT has a press to measure from; a reload of an old
  // session must report nothing rather than a number counted from mount.
  test('a timeline with no send press reports nothing', () => {
    expect(
      sendToFirstOutputMs({
        sendStartedAt: null,
        entries: [{ label: FIRST_OUTPUT_MARK, at: 9_750 }],
      }),
    ).toBeNull();
  });

  test('no first-output mark yet reports nothing', () => {
    expect(
      sendToFirstOutputMs({ sendStartedAt: 1_000, entries: [{ label: 'chat-ready', at: 2_000 }] }),
    ).toBeNull();
  });

  test('a repeated mark cannot move the measurement — the first one wins', () => {
    expect(
      sendToFirstOutputMs({
        sendStartedAt: 0,
        entries: [
          { label: FIRST_OUTPUT_MARK, at: 500 },
          { label: FIRST_OUTPUT_MARK, at: 9_000 },
        ],
      }),
    ).toBe(500);
  });
});

describe('markSessionFirstOutput', () => {
  const hadWindow = 'window' in globalThis;
  let lines: string[] = [];
  const realLog = console.log;

  beforeAll(() => {
    if (!hadWindow) (globalThis as { window?: unknown }).window = {};
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
  });
  afterAll(() => {
    console.log = realLog;
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  });

  test('a session sent from the composer logs send-to-first-output', () => {
    lines = [];
    markSessionClick();
    beginSessionTiming('sess-sent');
    sessionMark('sess-sent', 'chat-ready');

    markSessionFirstOutput('sess-sent');

    const logged = lines.filter((line) => line.includes('sendToFirstOutputMs'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/sendToFirstOutputMs \d+ms/);
  });

  test('a session this tab did not send logs the mark but no measurement', () => {
    lines = [];
    sessionMark('sess-opened', 'chat-ready');

    markSessionFirstOutput('sess-opened');

    expect(lines.some((line) => line.includes(FIRST_OUTPUT_MARK))).toBe(true);
    expect(lines.some((line) => line.includes('sendToFirstOutputMs'))).toBe(false);
  });

  function burnMs(ms: number): void {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      // spin
    }
  }

  function measuredMs(): number {
    const logged = lines.filter((line) => line.includes('sendToFirstOutputMs'));
    expect(logged).toHaveLength(1);
    const match = /sendToFirstOutputMs (\d+)ms/.exec(logged[0]);
    expect(match, `no measurement in: ${logged[0]}`).not.toBeNull();
    return Number(match?.[1]);
  }

  // Control for the case below: a press the create DID honour still backdates.
  test('a press that produced a session backdates the timeline to it', () => {
    lines = [];
    markSessionClick();
    burnMs(30);
    beginSessionTiming('sess-backdated');

    markSessionFirstOutput('sess-backdated');

    expect(measuredMs()).toBeGreaterThanOrEqual(25);
  });

  // A refused create (session cap, connector gate, a throw before the POST)
  // never reaches `onNavigate`, so nothing consumed the press. Left pending it
  // backdates the NEXT session the tab starts by however long the user idled,
  // and the measurement is unusable.
  test('an abandoned press does not backdate the next timeline', () => {
    lines = [];
    markSessionClick();
    clearSessionClick();
    burnMs(30);
    beginSessionTiming('sess-after-refusal');

    markSessionFirstOutput('sess-after-refusal');

    expect(measuredMs()).toBeLessThan(25);
  });

  test('the mark is filed once — a second call logs nothing more', () => {
    lines = [];
    markSessionClick();
    beginSessionTiming('sess-twice');
    markSessionFirstOutput('sess-twice');
    const after = lines.length;

    markSessionFirstOutput('sess-twice');

    expect(lines).toHaveLength(after);
  });
});
