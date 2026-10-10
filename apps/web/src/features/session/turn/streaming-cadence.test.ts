import { describe, expect, test } from 'bun:test';

import {
  STREAM_COMMIT_MS,
  STREAM_FADE_MS,
  createStreamPacer,
  revealCut,
  type PacerClock,
} from './streaming-cadence';

/** A manual 60 Hz frame clock, so every reveal is asserted exactly. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  let hidden = false;
  const frames = new Map<number, () => void>();
  const clock: PacerClock = {
    now: () => now,
    requestFrame: (fn) => {
      const id = nextId++;
      frames.set(id, fn);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id as number);
    },
    hidden: () => hidden,
  };
  return {
    clock,
    /** Run frames every 16 ms for `ms`. */
    advance(ms: number) {
      const until = now + ms;
      while (now + 16 <= until) {
        now += 16;
        const due = [...frames.values()];
        frames.clear();
        for (const fn of due) fn();
      }
      now = until;
    },
    pending: () => frames.size,
    setHidden: (value: boolean) => {
      hidden = value;
    },
  };
}

function setup(initial = '', initialStreaming = false) {
  const t = fakeClock();
  const shown: string[] = [];
  const settles: number[] = [];
  const pacer = createStreamPacer(
    (text, streaming) => {
      if (streaming) shown.push(text);
      else settles.push(t.clock.now());
      if (!streaming && shown[shown.length - 1] !== text) shown.push(text);
    },
    initial,
    t.clock,
    initialStreaming,
  );
  return { ...t, shown, settles, pacer, last: () => shown[shown.length - 1] };
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('revealCut', () => {
  test('extends the cut to the end of the word it lands in', () => {
    expect(revealCut('hello world again', 0, 2, false)).toBe(5);
    expect(revealCut('hello world again', 5, 3, false)).toBe(11);
  });

  test('never shows the trailing word while the stream is live, and shows it when final', () => {
    expect(revealCut('hello wor', 0, 100, false)).toBe(6);
    expect(revealCut('hello wor', 0, 100, true)).toBe(9);
  });

  test('reveals a syntax-only word together with the word after it', () => {
    expect(revealCut('intro\n\n## Heading more', 5, 3, false)).toBe(17);
    expect(revealCut('a\n- item b', 1, 2, false)).toBe(8);
    expect(revealCut('a\n1. first b', 1, 2, false)).toBe(10);
  });

  test('backs off past a syntax-only word that would end the visible text', () => {
    expect(revealCut('intro ## Head', 0, 100, false)).toBe(6);
  });

  test('reveals a link destination as it arrives: it renders as its label or its card, never as half a word', () => {
    const text = 'Here is the link: [Connect Outlook](https://x.test/connect/ksl_ab';
    expect(revealCut(text, 0, Infinity, false)).toBe(text.length);
    expect(revealCut(`${text}c)`, 0, Infinity, false)).toBe(text.length + 2);
    // A label word that is still arriving waits like any other word.
    expect(revealCut('Here is the link: [Connect Out', 0, Infinity, false)).toBe(
      'Here is the link: [Connect '.length,
    );
  });

  test('a budget under one char reveals nothing', () => {
    expect(revealCut('hello world', 5, 0.5, false)).toBe(5);
  });
});

describe('createStreamPacer', () => {
  test('text present at mount shows at once and is never re-typed', () => {
    const p = setup('already here ');
    p.pacer.push('already here ', true);
    p.advance(500);
    expect(p.shown).toEqual([]);
  });

  test('one large chunk is revealed over many renders, never all at once', () => {
    const p = setup();
    const chunk = `${words(80)} `;
    p.pacer.push(chunk, true);
    p.advance(48);
    expect(p.shown.length).toBeGreaterThan(0);
    expect(p.last().length).toBeLessThan(chunk.length / 4);
    p.advance(2000);
    expect(p.last()).toBe(chunk);
    expect(p.shown.length).toBeGreaterThan(15);
  });

  test('every render is a word-boundary prefix of the target and strictly grows', () => {
    const p = setup();
    const full = `${words(60)} `;
    for (let i = 7; i <= full.length; i += 7) {
      p.pacer.push(full.slice(0, i), true);
      p.advance(16);
    }
    p.pacer.push(full, true);
    p.advance(2000);
    let prev = 0;
    for (const s of p.shown) {
      expect(full.startsWith(s)).toBe(true);
      expect(s.length).toBeGreaterThan(prev);
      expect(s.length === full.length || full[s.length] === ' ').toBe(true);
      prev = s.length;
    }
    expect(p.last()).toBe(full);
  });

  test('renders are at least STREAM_COMMIT_MS apart', () => {
    const p = setup();
    const at: number[] = [];
    const pacer = createStreamPacer((_, streaming) => streaming && at.push(p.clock.now()), '', p.clock);
    pacer.push(`${words(200)} `, true);
    p.advance(3000);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(STREAM_COMMIT_MS);
    }
  });

  test('the visible text stays close behind a steady stream', () => {
    const p = setup();
    const full = `${words(300)} `;
    // ~440 chars a second, in 16 ms deltas.
    let received = '';
    for (let i = 0; received.length < full.length; i++) {
      received = full.slice(0, Math.min(full.length, (i + 1) * 7));
      p.pacer.push(received, true);
      p.advance(16);
      if (i > 60) expect(received.length - p.last().length).toBeLessThan(250);
    }
  });

  test('bursty chunks reveal at a steady speed, not in surges', () => {
    const p = setup();
    const full = `${words(400)} `;
    // 60 chars every 150 ms (400 chars/s), the shape of a batching gateway.
    const sizes: number[] = [];
    let received = 0;
    let prev = 0;
    for (let ms = 0; ms < 6000; ms += 16) {
      if (ms % 144 === 0 && received < full.length) {
        received = Math.min(full.length, received + 58);
        p.pacer.push(full.slice(0, received), true);
      }
      p.advance(16);
      if (ms % 96 === 0) {
        if (ms > 1500 && ms < 4500) sizes.push(p.last().length - prev);
        prev = p.last().length;
      }
    }
    // Every 96 ms window of the steady phase reveals text: no stall between chunks.
    expect(Math.min(...sizes)).toBeGreaterThan(0);
    // And no window reveals more than ~2.5x the mean: no surge after a chunk.
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    expect(Math.max(...sizes)).toBeLessThan(mean * 2.5);
  });

  test('the stream ending settles only after the last word has faded in', () => {
    const p = setup();
    const full = `${words(10)} `;
    p.pacer.push(full, true);
    p.advance(2000);
    expect(p.last()).toBe(full);
    expect(p.settles).toEqual([]);
    const endAt = p.clock.now();
    p.pacer.push(full, false);
    p.advance(STREAM_FADE_MS + 40);
    expect(p.settles.length).toBe(1);
    expect(p.settles[0] - endAt).toBeGreaterThanOrEqual(STREAM_FADE_MS);
    expect(p.pending()).toBe(0);
  });

  test('the stream ending drains the rest within a few hundred ms and drops nothing', () => {
    const p = setup();
    const full = `${words(120)} tail`;
    p.pacer.push(full, true);
    p.advance(48);
    p.pacer.push(full, false);
    p.advance(400 + STREAM_FADE_MS);
    expect(p.last()).toBe(full);
    expect(p.settles.length).toBe(1);
    expect(p.pending()).toBe(0);
  });

  test('a trailing partial word waits without spinning frames, then lands on the next chunk', () => {
    const p = setup();
    p.pacer.push('hello wor', true);
    p.advance(500);
    expect(p.last()).toBe('hello ');
    expect(p.pending()).toBe(0);
    p.pacer.push('hello world ', true);
    p.advance(200);
    expect(p.last().trimEnd()).toBe('hello world');
  });

  test('text that does not extend the shown text shows at once', () => {
    const p = setup('first answer');
    p.pacer.push('rewritten', true);
    expect(p.last()).toBe('rewritten');
  });

  test('text present at mount while streaming settles when the stream ends with no new text', () => {
    // A refresh or tab switch mid-answer mounts the whole text at once. When the
    // turn then ends without another chunk, the message must still settle.
    const p = setup('already here ', true);
    p.pacer.push('already here ', true);
    p.advance(500);
    expect(p.settles).toEqual([]);
    const endAt = p.clock.now();
    p.pacer.push('already here ', false);
    p.advance(STREAM_FADE_MS + 40);
    expect(p.settles.length).toBe(1);
    expect(p.settles[0] - endAt).toBeGreaterThanOrEqual(STREAM_FADE_MS);
    expect(p.pending()).toBe(0);
  });

  test('a value that was never streamed shows at once', () => {
    const p = setup('old');
    p.pacer.push('old and new', false);
    expect(p.last()).toBe('old and new');
    expect(p.settles.length).toBe(1);
    expect(p.pending()).toBe(0);
  });

  test('a hidden tab shows the text at once', () => {
    const p = setup();
    p.setHidden(true);
    p.pacer.push(`${words(50)} `, true);
    expect(p.last()).toBe(`${words(50)} `);
  });

  test('dispose cancels the pending frame', () => {
    const p = setup();
    p.pacer.push(`${words(50)} `, true);
    p.pacer.dispose();
    expect(p.pending()).toBe(0);
  });
});
