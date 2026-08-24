import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PlanCard, keyTodos, planListTodos, planRingState, planSummary } from './plan-card';

describe('planRingState', () => {
  test('the wedge is the completed share of a full turn', () => {
    expect(planRingState(3, 4, false).sweep).toBe(270); // the 75% cake
    expect(planRingState(2, 5, true).sweep).toBe(144);
    expect(planRingState(1, 4, false).sweep).toBe(90);
  });

  test('a finished plan sweeps the full circle and reports complete', () => {
    expect(planRingState(4, 4, false)).toEqual({ sweep: 360, state: 'complete' });
  });

  test('complete wins over running — a plan cannot be both', () => {
    expect(planRingState(4, 4, true).state).toBe('complete');
  });

  test('a running plan reports running', () => {
    expect(planRingState(2, 5, true).state).toBe('running');
  });

  test('an untouched plan draws bare track', () => {
    expect(planRingState(0, 5, false)).toEqual({ sweep: 0, state: 'idle' });
  });

  test('an empty plan does not divide by zero and is never "complete"', () => {
    // 0 === 0 would read as complete without the `total > 0` guard.
    expect(planRingState(0, 0, false)).toEqual({ sweep: 0, state: 'idle' });
    expect(Number.isNaN(planRingState(0, 0, false).sweep)).toBe(false);
  });
});

describe('planSummary', () => {
  test('counts completed todos and rounds the percentage', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'completed', content: 'b' },
      { status: 'completed', content: 'c' },
      { status: 'in_progress', content: 'd' },
      { status: 'pending', content: 'e' },
      { status: 'pending', content: 'f' },
      { status: 'pending', content: 'g' },
    ]);

    expect(summary.done).toBe(3);
    expect(summary.total).toBe(7);
    expect(summary.percent).toBe(43);
    expect(summary.current).toBe('d');
  });

  test('current is the in_progress item', () => {
    const summary = planSummary([
      { status: 'completed', content: 'done' },
      { status: 'in_progress', content: 'Auditing worker registration' },
    ]);
    expect(summary.current).toBe('Auditing worker registration');
  });

  test('no in_progress item leaves current undefined', () => {
    const summary = planSummary([{ status: 'pending', content: 'a' }]);
    expect(summary.current).toBeUndefined();
  });

  test('the running step wins the title, and completion has its own label', () => {
    expect(
      planSummary([
        { status: 'completed', content: 'a' },
        { status: 'in_progress', content: 'Wire the retry budget' },
      ]).label,
    ).toBe('Wire the retry budget');
    expect(planSummary([{ status: 'completed', content: 'a' }]).label).toBe('Plan complete');
  });

  test('an all-complete plan is 100 percent with no current item', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'completed', content: 'b' },
    ]);
    expect(summary.percent).toBe(100);
    expect(summary.current).toBeUndefined();
    expect(summary.complete).toBe(true);
    expect(summary.label).toBe('Plan complete');
  });

  test('an empty plan is zero percent and does not divide by zero', () => {
    const summary = planSummary([]);
    expect(summary).toEqual({
      done: 0,
      total: 0,
      percent: 0,
      current: undefined,
      label: undefined,
      complete: false,
    });
  });

  test('idle pending steps do not claim the plan is complete', () => {
    const summary = planSummary([{ status: 'pending', content: 'a' }]);
    expect(summary.complete).toBe(false);
    expect(summary.label).toBeUndefined();
  });

  test('a live step wins the label over the complete fallback', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'in_progress', content: 'Wire the retry budget' },
    ]);
    expect(summary.label).toBe('Wire the retry budget');
    expect(summary.complete).toBe(false);
  });

  test('cancelled todos count toward the total but not toward done', () => {
    const summary = planSummary([
      { status: 'completed', content: 'a' },
      { status: 'cancelled', content: 'b' },
    ]);
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(2);
  });
});

describe('keyTodos', () => {
  /**
   * Todos carry no id. Keying the list on `content` alone gave React duplicate
   * keys the moment an agent repeated a line, which detaches row state from the
   * row it belongs to.
   */
  test('a repeated line gets a distinct key per occurrence', () => {
    const keys = keyTodos([
      { content: 'Run the tests', status: 'completed' },
      { content: 'Fix the failure', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ]).map((k) => k.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      'Run the tests',
      'Fix the failure',
      'Run the tests#1',
      'Run the tests#2',
    ]);
  });

  test('the first occurrence keeps the bare content, so keys stay stable as a plan grows', () => {
    const [first] = keyTodos([{ content: 'Ship it', status: 'pending' }]);
    expect(first.key).toBe('Ship it');
    const grown = keyTodos([
      { content: 'Ship it', status: 'completed' },
      { content: 'Ship it again', status: 'pending' },
    ]);
    expect(grown[0].key).toBe('Ship it');
  });

  test('the todo itself rides along, so callers do not re-index to read it', () => {
    const [only] = keyTodos([{ content: 'Ship it', status: 'in_progress' }]);
    expect(only.todo.status).toBe('in_progress');
  });

  test('an empty plan keys nothing', () => {
    expect(keyTodos([])).toEqual([]);
  });
});

describe('PlanRing — the dial actually reports the plan', () => {
  /**
   * The ring is the one piece of information in the collapsed card's first row,
   * and all of it is expressed as SVG attributes rather than as text — exactly
   * the kind of thing that rots silently. These pin the two numbers a reader
   * sees: how far the sweep goes, and where the bead sits.
   *
   * `pathLength={6}` denominates the sweep in segments, so a plan 1/3 done
   * leaves `6 * (1 - 1/3) = 4` of dash offset still to travel.
   */
  const SESSION = 'ses_ring';

  const renderRing = (todos: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(['opencode', 'session-todo', SESSION], todos);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PlanCard sessionId={SESSION} />
      </QueryClientProvider>,
    );
  };

  const todo = (content: string, status: string) => ({ content, status });

  /**
   * Just the dial's own markup, so a count of `<circle>` means the dial's.
   *
   * Anchored on the `<svg` that OPENS the dial, not on `role="img"` itself:
   * `viewBox` is written before `role`, so slicing at the role attribute cuts
   * the viewBox off and any assertion about it silently fails.
   */
  const readDial = (todos: unknown[]) => {
    const markup = renderRing(todos);
    const role = markup.indexOf('role="img"');
    expect(role).toBeGreaterThan(-1);
    const from = markup.lastIndexOf('<svg', role);
    return markup.slice(from, markup.indexOf('</svg>', from));
  };

  test('the sweep is the completed share of the ring', () => {
    const markup = renderRing([
      todo('a', 'completed'),
      todo('b', 'in_progress'),
      todo('c', 'pending'),
    ]);
    expect(markup).toContain('stroke-dashoffset="4"');
  });

  test('the sweep starts at twelve o\'clock, not at three', () => {
    // SVG circles start at 3 o'clock; progress has to read from the top.
    const markup = renderRing([todo('a', 'completed'), todo('b', 'pending')]);
    expect(markup).toContain('rotate(-90 8 8)');
  });

  /**
   * The dial carries no travelling bead any more — see the block comment in
   * `plan-card.tsx`. At 1.5 units of stroke a bead has to be ~2x the track's
   * weight to register, and a dot that fat hangs off the arc head as a blob.
   * The pie in the middle states the same fraction where nothing competes.
   */
  test('no bead: stencil, track, sweep, pie — and nothing else', () => {
    const dial = readDial([
      todo('a', 'completed'),
      todo('b', 'in_progress'),
      todo('c', 'pending'),
      todo('d', 'pending'),
    ]);
    expect(dial.match(/<circle /g)).toHaveLength(4);
    // A bead was a rotated `fill="currentColor"` dot riding the ring.
    expect(dial).not.toContain('rotate(90deg)');
    expect(dial).not.toContain('fill="currentColor"');
  });

  test('an untouched plan draws bare track', () => {
    const markup = renderRing([todo('a', 'pending'), todo('b', 'pending')]);
    expect(markup).toContain('stroke-dashoffset="6"');
  });

  test('a finished plan closes the ring', () => {
    const markup = renderRing([todo('a', 'completed'), todo('b', 'completed')]);
    expect(markup).toContain('stroke-dashoffset="0"');
    expect(markup).toContain('text-kortix-green');
  });

  test('a running plan is amber, a finished one green — never a raw palette colour', () => {
    const running = renderRing([todo('a', 'in_progress'), todo('b', 'pending')]);
    expect(running).toContain('text-kortix-orange');
    expect(running).not.toContain('emerald');
    expect(running).not.toContain('amber');
  });

  test('the dial is six segments, cut once and reused by every layer', () => {
    const markup = renderRing([todo('a', 'completed'), todo('b', 'pending')]);
    expect(markup).toContain('stroke-dasharray="0.47 0.53"');
    expect(markup).toContain('pathLength="6"');
    expect(markup.match(/<mask /g)).toHaveLength(1);
  });

  /**
   * The point of the rebuild: the dial and the `pending` glyph in the list below
   * it are ONE drawing. If either drifts onto its own circle again, the card
   * goes back to showing two different rings for the same idea.
   */
  test('the dial is drawn on the same circle as the pending todo glyph', () => {
    // Scoped to the dial. A collapsed card renders no list, and its only other
    // glyph is the spinner — which is present only while something runs. So a
    // whole-card count would be a moving target; the dial itself is not.
    const d = readDial([todo('a', 'completed'), todo('b', 'pending')]);
    // Stencil, track and sweep are all r=6.3 / stroke 1.5 on a 16 viewBox — the
    // `pending` glyph's circle. `todo-helpers.test.tsx` pins the other end of
    // that equality.
    expect(d.match(/r="6.3"/g)).toHaveLength(3);
    expect(d).toContain('viewBox="0 0 16 16"');
    expect(d).not.toContain('viewBox="0 0 24 24"');
    expect(d).toContain('stroke-width="1.5"');
    expect(d).not.toContain('stroke-width="4"');
  });

  /**
   * The tick stencil is cut with BUTT caps, exactly like the glyph it copies.
   * Round caps would extend every tick by half the stroke width at each end —
   * 1.5 units added to a 3-unit tick — and the dial would read chunky next to a
   * pending todo drawn from the same numbers.
   */
  test('the ticks are cut square, so they match the glyph rather than fatten it', () => {
    const markup = renderRing([todo('a', 'completed'), todo('b', 'pending')]);
    const mask = markup.slice(markup.indexOf('<mask'), markup.indexOf('</mask>'));
    expect(mask).toContain('stroke-linecap="butt"');
    expect(mask).not.toContain('stroke-linecap="round"');
  });

  test('an untouched dial is the pending glyph: full-strength muted, not faded', () => {
    const markup = renderRing([todo('a', 'pending'), todo('b', 'pending')]);
    expect(markup).toContain('class="text-muted-foreground"');
    expect(markup).not.toContain('text-muted-foreground/25');
  });

  test('the ring is announced, not left as decoration', () => {
    const markup = renderRing([todo('a', 'completed'), todo('b', 'pending')]);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="1 of 2 steps done"');
  });

  test('no plan, no card', () => {
    expect(renderRing([])).toBe('');
  });
});

/**
 * The trigger heads the running step; the list carries everything else.
 *
 * Before this split the running todo was printed twice — once as the trigger's
 * subject and once as the first list row, the same sentence stacked on itself
 * with two different glyphs. These pin both halves, because either one alone
 * still renders something plausible.
 */
describe('the trigger and the list do not print the same step twice', () => {
  const SESSION = 'ses_split';

  const card = (todos: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(['opencode', 'session-todo', SESSION], todos);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PlanCard sessionId={SESSION} />
      </QueryClientProvider>,
    );
  };

  const RUNNING = [
    { content: 'Inspect the starter repo', status: 'completed' },
    { content: 'Build the responsive site', status: 'in_progress' },
    { content: 'Run browser QA', status: 'pending' },
  ];

  test('the running step appears exactly once in the whole card', () => {
    const markup = card(RUNNING);
    expect(markup.match(/Build the responsive site/g)).toHaveLength(1);
  });

  test('the list keeps the finished and pending rows', () => {
    // Dropping the running row must not drop its neighbours: the completed rows
    // are the history and the pending ones are the road ahead.
    const list = planListTodos(keyTodos(RUNNING as any));
    expect(list.map((r) => r.todo.content)).toEqual([
      'Inspect the starter repo',
      'Run browser QA',
    ]);
  });

  test('filtering happens after keying, so surviving rows keep their keys', () => {
    // Keys must not shift as the agent advances, or React reattaches row state
    // to the wrong row. Here the second "Ship it" keeps `#1` even though the
    // first one was filtered out.
    const keys = planListTodos(
      keyTodos([
        { content: 'Ship it', status: 'in_progress' },
        { content: 'Ship it', status: 'pending' },
      ]),
    ).map((r) => r.key);
    expect(keys).toEqual(['Ship it#1']);
  });

  test('a plan with nothing running loses no rows', () => {
    const all = planListTodos(
      keyTodos([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ]),
    );
    expect(all).toHaveLength(2);
  });
});

/**
 * `Loading` ships `in-[button]:text-background` for spinners sitting on FILLED
 * buttons, plus `in-[button.bg-transparent]:text-foreground` for transparent
 * ones. The trigger is a transparent `<button>`, so that second rule matches and
 * would repaint the running glyph in the body colour.
 *
 * `cn()` does not resolve it: twMerge only dedupes inside a variant group, and
 * both of those are prefixed, so they never collide with an unprefixed tint.
 * Both land in the DOM and the prefixed one wins. Hence two defences, asserted
 * here — this bit has already regressed once.
 */
describe('the trigger spinner survives living inside a <button>', () => {
  const SESSION = 'ses_spinner';

  const collapsed = () => {
    const client = new QueryClient();
    client.setQueryData(
      ['opencode', 'session-todo', SESSION],
      [
        { content: 'Audit the worker registration', status: 'completed' },
        { content: 'Wire the retry budget', status: 'in_progress' },
      ],
    );
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PlanCard sessionId={SESSION} />
      </QueryClientProvider>,
    );
  };

  const trigger = () => {
    const markup = collapsed();
    return markup.slice(markup.indexOf('<button'), markup.indexOf('</button>'));
  };

  test('the spinner carries an important brand colour, which outranks in-[button]', () => {
    expect(trigger()).toContain('text-kortix-orange!');
  });

  test('the trigger declares itself transparent, so Loading takes its own escape hatch', () => {
    const markup = collapsed();
    const open = markup.indexOf('<button');
    expect(markup.slice(open, markup.indexOf('>', open))).toContain('bg-transparent');
  });

  test('the running glyph really is the spinner component', () => {
    expect(trigger()).toContain('animate-spinner-dash');
  });
});

describe('PlanRing — the pie', () => {
  const SESSION = 'ses_pie';

  const dial = (done: number, total: number) => {
    const client = new QueryClient();
    client.setQueryData(
      ['opencode', 'session-todo', SESSION],
      Array.from({ length: total }, (_, i) => ({
        content: `t${i}`,
        status: i < done ? 'completed' : 'pending',
      })),
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PlanCard sessionId={SESSION} />
      </QueryClientProvider>,
    );
    const from = markup.indexOf('role="img"');
    return markup.slice(from, markup.indexOf('</svg>', from));
  };

  const pie = (markup: string) => {
    const m = markup.match(/<circle cx="8" cy="8" r="1.8"[^>]*>/);
    return m?.[0] ?? '';
  };

  test('the stroke is twice the path radius, so the slice reaches the centre', () => {
    // r=1.8 stroked at 3.6 covers 0 → 3.6: a solid disc. Any other pairing
    // leaves a hole in the middle (donut) or spills past the intended radius.
    const p = pie(dial(3, 6));
    expect(p).toContain('r="1.8"');
    expect(p).toContain('stroke-width="3.6"');
  });

  test('the slice clears the ring it sits inside', () => {
    // Ring ink stops at 6.3 − 1.5/2 = 5.55; the pie ends at 3.6. 1.95 units of
    // air, ~2.2px at the shipping 18px, and that is the floor: at r=3.9 it drops
    // to 1.65 and a wide slice visibly reaches for the ring.
    //
    // toBeCloseTo, not an exact `>=`: 6.3 − 0.75 − 3.6 evaluates to
    // 1.9499999999999997 in binary floating point, so `>= 1.95` would be a coin
    // toss on arithmetic noise rather than a statement about the drawing.
    const ringInnerEdge = 6.3 - 1.5 / 2;
    expect(ringInnerEdge - 3.6).toBeCloseTo(1.95, 5);
  });

  test('butt caps make the cut edges true radii, not rounded lumps', () => {
    expect(pie(dial(1, 6))).toContain('stroke-linecap="butt"');
  });

  test('the offset is the completed fraction, denominated directly', () => {
    // pathLength={1} means dashoffset IS `1 - done/total` — no circumference
    // constant to drift, no rounding to accumulate.
    expect(pie(dial(3, 6))).toContain('stroke-dashoffset="0.5"');
    expect(pie(dial(1, 4))).toContain('stroke-dashoffset="0.75"');
    expect(pie(dial(6, 6))).toContain('stroke-dashoffset="0"');
  });

  test('the slice starts at twelve o\'clock and sweeps with the ring', () => {
    expect(pie(dial(1, 6))).toContain('rotate(-90 8 8)');
  });

  test('an untouched plan draws no slice at all', () => {
    // Nothing done, nothing to draw — which leaves the dial pixel for pixel the
    // `pending` glyph. A faint full-disc track used to sit here and was dropped:
    // at 18px it blurred into the wedge and put a grey dot in an empty plan.
    expect(pie(dial(0, 6))).toBe('');
    expect(dial(0, 6)).not.toContain('opacity-15');
  });

  test('the slice grows with the ring, on the same curve and duration', () => {
    // Both carve `stroke-dashoffset`; if only one transitions, the glyph tears
    // as the plan advances.
    const d = dial(3, 6);
    expect(d.match(/transition-\[stroke-dashoffset\] duration-500/g)).toHaveLength(2);
  });
});
