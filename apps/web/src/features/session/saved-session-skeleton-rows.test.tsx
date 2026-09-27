import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SavedSessionSkeletonRows, SkeletonBar } from './saved-session-skeleton-rows';
import { savedSessionSkeletonShape } from './saved-session-skeleton-shape';

const A = '2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';
const B = '9b1d4e7a-3c2f-4a6b-8e5d-1f0c9a8b7d6e';

const rows = (sessionId: string) =>
  renderToStaticMarkup(<SavedSessionSkeletonRows shape={savedSessionSkeletonShape(sessionId)} />);

/** Every placeholder bar in the markup, by its pulse delay. */
const delays = (html: string) => [...html.matchAll(/animation-delay:(-?\d+)ms/g)].map((m) => Number(m[1]));

describe('SavedSessionSkeletonRows', () => {
  test('a session renders the same markup every time', () => {
    // The server and the client render this; different markup fails hydration.
    expect(rows(A)).toBe(rows(A));
  });

  test('two sessions render different conversations', () => {
    expect(rows(A)).not.toBe(rows(B));
  });

  test('every bar is on the wave, and the wave starts at the top', () => {
    const shape = savedSessionSkeletonShape(A);
    const html = rows(A);
    const toolRows = shape.turns.filter((turn) => turn.tool).length;
    // A tool row is two bars on one phase (its icon and its label); the
    // composer's phase is drawn by the page, not by these rows.
    expect(delays(html)).toHaveLength(shape.phases - 1 + toolRows);
    expect(delays(html)[0]).toBe(0);
    expect(delays(html).every((delay) => delay <= 0)).toBe(true);
  });

  test('with reduced motion no bar pulses', () => {
    const html = rows(A);
    const bars = html.match(/class="[^"]*animate-pulse[^"]*"/g) ?? [];
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar).toContain('motion-reduce:animate-none');
  });
});

describe('SkeletonBar', () => {
  test('carries its phase as an animation delay and sets its own height', () => {
    const html = renderToStaticMarkup(<SkeletonBar phase={3} phases={4} className="h-3.5 w-1/2" />);
    expect(html).toContain('animation-delay:-500ms');
    // The primitive pads itself (`py-4`); a bar's height is its own.
    expect(html).toContain('py-0');
    expect(html).toContain('h-3.5 w-1/2');
  });
});
