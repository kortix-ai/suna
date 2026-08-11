import { describe, expect, test } from 'bun:test';
import { buildFeed, elapsedLabel, foldAskSettlements, outcomeTone } from './feed';
import type { CallRecordEntry } from './types';

function entry(partial: Partial<CallRecordEntry> & { cursor: number }): CallRecordEntry {
  return {
    kind: 'voice',
    name: 'dosco',
    text: 'hi',
    outcome: null,
    at: '2026-07-26T10:00:00.000Z',
    ...partial,
  };
}

function ask(cursor: number, text = 'what broke the build?', at?: string): CallRecordEntry {
  return entry({ cursor, kind: 'tool', name: 'ask_kortix', text, ...(at ? { at } : {}) });
}

function settled(cursor: number, outcome = 'answered', at?: string): CallRecordEntry {
  return entry({
    cursor,
    kind: 'tool',
    name: 'ask_kortix_done',
    text: outcome,
    ...(at ? { at } : {}),
  });
}

describe('foldAskSettlements — one hand-off is one row, not two', () => {
  test('a settle closes the ask it follows and disappears into it', () => {
    const rows = foldAskSettlements([ask(1), settled(2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry).toMatchObject({
      name: 'ask_kortix',
      text: 'what broke the build?',
      outcome: 'answered',
    });
    expect(rows[0]!.pending).toBe(false);
  });

  test('the folded row keeps the ASK cursor and time, so it stays where it happened', () => {
    const rows = foldAskSettlements([
      ask(7, 'summarize the deploy', '2026-07-26T10:00:00.000Z'),
      settled(9, 'answered', '2026-07-26T10:00:41.000Z'),
    ]);
    expect(rows[0]!.entry.cursor).toBe(7);
    expect(rows[0]!.entry.at).toBe('2026-07-26T10:00:00.000Z');
    expect(rows[0]!.settledAt).toBe('2026-07-26T10:00:41.000Z');
  });

  test('an ask with no settle yet is pending — the answer is still coming', () => {
    const rows = foldAskSettlements([ask(1)]);
    expect(rows[0]).toMatchObject({ pending: true, settledAt: null });
    expect(rows[0]!.entry.outcome).toBeNull();
  });

  test('every ending the watch can produce carries through as the outcome', () => {
    // The vocabulary is answer-watch.ts's WatchOutcome plus askdosco's two
    // delivery failures — all of them settle a hand-off, so all of them have to
    // be able to close a row.
    for (const outcome of [
      'answered',
      'failed',
      'nothing to say',
      'session unreadable',
      'timed out',
      'not delivered',
      'delivery failed',
    ]) {
      const rows = foldAskSettlements([ask(1), settled(2, outcome)]);
      expect(rows[0]!.entry.outcome).toBe(outcome);
    }
  });

  test('a second hand-off is its own row — a settle never closes two asks', () => {
    const rows = foldAskSettlements([ask(1, 'first'), settled(2), ask(3, 'second'), settled(4, 'timed out')]);
    expect(rows.map((r) => [r.entry.text, r.entry.outcome])).toEqual([
      ['first', 'answered'],
      ['second', 'timed out'],
    ]);
  });

  test('a settle with no open ask is still shown — a real row is never swallowed', () => {
    // Its ask is missing from what we hold (a stale in-flight row expiring, a
    // double settle). Hiding it to keep the display tidy would hide the one
    // clue that something is off.
    const rows = foldAskSettlements([settled(5, 'timed out')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry).toMatchObject({ name: 'ask_kortix', text: '', outcome: 'timed out' });
  });

  test('a settle already consumed does not reach back and re-close the same ask', () => {
    const rows = foldAskSettlements([ask(1), settled(2), settled(3, 'timed out')]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entry.outcome).toBe('answered');
    expect(rows[1]!.entry).toMatchObject({ name: 'ask_kortix', text: '', outcome: 'timed out' });
  });

  test('a settle with an empty detail still says the hand-off ended', () => {
    const rows = foldAskSettlements([ask(1), settled(2, '')]);
    expect(rows[0]!.entry.outcome).toBe('done');
    expect(rows[0]!.pending).toBe(false);
  });

  test('other tools are untouched — run_command settles inline, in one row', () => {
    const cmd = entry({ cursor: 1, kind: 'tool', name: 'run_command', text: 'bun test', outcome: 'ok' });
    const rows = foldAskSettlements([cmd]);
    expect(rows).toEqual([{ entry: cmd, pending: false, settledAt: null }]);
  });

  test('speech passes through untouched', () => {
    const said = entry({ cursor: 1, kind: 'human', name: 'Guest', text: 'hello' });
    expect(foldAskSettlements([said])[0]!.entry).toBe(said);
  });
});

describe('buildFeed — the name goes on the run, not on every bubble', () => {
  test('consecutive lines by the same speaker are labelled once', () => {
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'voice', name: 'dosco' }),
      entry({ cursor: 2, kind: 'voice', name: 'dosco' }),
      entry({ cursor: 3, kind: 'voice', name: 'dosco' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, false, false]);
  });

  test('the speaker changing starts a new run', () => {
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'voice', name: 'dosco' }),
      entry({ cursor: 2, kind: 'human', name: 'Guest' }),
      entry({ cursor: 3, kind: 'voice', name: 'dosco' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, true, true]);
  });

  test('the two agent-side sources never share a run — that is the whole point of telling them apart', () => {
    // Same role server-side, different actors: the voice speaking versus the
    // dosco agent putting a line into the call.
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'voice', name: 'dosco' }),
      entry({ cursor: 2, kind: 'kortix', name: 'dosco agent' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, true]);
  });

  test('two humans with different names do not share a run', () => {
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'human', name: 'Marko' }),
      entry({ cursor: 2, kind: 'human', name: 'Guest' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, true]);
  });

  test('a tool call between two lines does NOT re-label the speaker', () => {
    // A hand-off in the middle of the voice talking is the most common thing on
    // a call; letting it break the run would put the name back on nearly every
    // bubble, which is exactly the noise being removed.
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'voice', name: 'dosco' }),
      ask(2),
      entry({ cursor: 3, kind: 'voice', name: 'dosco' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, false, false]);
  });

  test('a long silence re-labels the same speaker — after a lull, who this is stops being obvious', () => {
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'voice', name: 'dosco', at: '2026-07-26T10:00:00.000Z' }),
      entry({ cursor: 2, kind: 'voice', name: 'dosco', at: '2026-07-26T10:01:00.000Z' }),
      entry({ cursor: 3, kind: 'voice', name: 'dosco', at: '2026-07-26T10:05:00.000Z' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, false, true]);
  });

  test('an unreadable timestamp shows the label rather than dropping the attribution', () => {
    const rows = buildFeed([
      entry({ cursor: 1, kind: 'voice', name: 'dosco' }),
      entry({ cursor: 2, kind: 'voice', name: 'dosco', at: 'not a date' }),
    ]);
    expect(rows.map((r) => r.showLabel)).toEqual([true, true]);
  });

  test('a tool row never claims to be a labelled speaker', () => {
    const rows = buildFeed([ask(1), settled(2)]);
    expect(rows[0]!.showLabel).toBe(false);
  });

  test('keys are the record cursors, so a merged poll re-renders in place', () => {
    const rows = buildFeed([entry({ cursor: 4 }), ask(5), settled(6), entry({ cursor: 7 })]);
    expect(rows.map((r) => r.key)).toEqual([4, 5, 7]);
  });
});

describe('outcomeTone — a failure has to read as a failure', () => {
  test('success words', () => {
    for (const ok of ['ok', 'answered', 'exit 0']) expect(outcomeTone(ok)).toBe('ok');
  });

  test('failure words, including any non-zero exit', () => {
    for (const bad of [
      'failed',
      'timed out',
      'delivery failed',
      'not delivered',
      'session unreadable',
      'exit 1',
      'exit 137',
      'exit -1',
    ]) {
      expect(outcomeTone(bad)).toBe('bad');
    }
  });

  test('an unrecognised outcome is neutral, never red', () => {
    // A word this page has not been taught yet must not invent a failure that
    // did not happen. 'nothing to say' is a real one: the turn finished with
    // nothing to report.
    expect(outcomeTone('nothing to say')).toBe('neutral');
    expect(outcomeTone('something new')).toBe('neutral');
  });
});

describe('elapsedLabel — how long the room waited', () => {
  test('seconds under a minute', () => {
    expect(elapsedLabel('2026-07-26T10:00:00.000Z', '2026-07-26T10:00:12.000Z')).toBe('12s');
  });

  test('minutes above it', () => {
    expect(elapsedLabel('2026-07-26T10:00:00.000Z', '2026-07-26T10:04:00.000Z')).toBe('4m');
  });

  test('nothing at all for a backwards or unreadable pair', () => {
    expect(elapsedLabel('2026-07-26T10:00:10.000Z', '2026-07-26T10:00:00.000Z')).toBeNull();
    expect(elapsedLabel('nope', '2026-07-26T10:00:00.000Z')).toBeNull();
  });
});
