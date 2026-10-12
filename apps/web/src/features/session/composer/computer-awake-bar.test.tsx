import { afterEach, describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import messages from '../../../../translations/en.json';
import { COMPUTER_AWAKE_TICK_MS, type ComputerAwakeLine } from './computer-awake';
import { ComputerAwakeBar, useComputerAwakeLine } from './computer-awake-bar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(line: ComputerAwakeLine): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ComputerAwakeBar line={line} />
    </NextIntlClientProvider>,
  );
}

/** The text of the bar's live region. */
function liveRegion(html: string): string | undefined {
  return /<span role="status" aria-live="polite" class="sr-only">([^<]*)<\/span>/.exec(html)?.[1];
}

// KRTX-1729: the composer says the computer stays on while the person is here.
describe('ComputerAwakeBar', () => {
  test('while presence extends: one muted line, a glyph, and a silent live region', () => {
    const html = render({ kind: 'stays', minutes: 100 });
    expect(html).toContain('data-testid="computer-awake-bar"');
    expect(html).toContain('Sandbox stays on while you&#x27;re here · up to 1 h 40 min');
    expect(html).toContain('<svg');
    expect(html).toContain('size-3.5 shrink-0 text-muted-foreground');
    // Its minutes change every minute: announcing each one would be noise.
    expect(liveRegion(html)).toBe('');
  });

  test('when presence no longer extends: the stop warning, announced once, with the warning hue on its glyph', () => {
    const html = render({ kind: 'stops', minutes: 12 });
    expect(html).toContain('Sandbox stops in 12 min. Send a message to keep it on.');
    expect(liveRegion(html)).toBe('Sandbox stops soon. Send a message to keep it on.');
    expect(html).toContain('text-kortix-orange');
    // Only the live region speaks: the countdown is not one.
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  // `role="status"` is atomic: a countdown inside it re-read the whole
  // sentence every minute for the last 15 min.
  test('the countdown moving does not change what the live region says', () => {
    const announced = liveRegion(render({ kind: 'stops', minutes: 12 }));
    expect(announced).toBeTruthy();
    expect(liveRegion(render({ kind: 'stops', minutes: 11 }))).toBe(announced);
  });

  // The duration ends the sentence: a truncated line cut it off at phone
  // width, and in de/fr at the 720 px desktop minimum.
  test('the line wraps instead of truncating, so the duration stays visible', () => {
    expect(render({ kind: 'stays', minutes: 100 })).not.toContain('truncate');
  });
});

// The clock used to tick every 30 s in SessionChat for every viewer, and the
// line was a new object on each tick, so the memo-wrapped composer re-rendered
// on every tick too.
describe('useComputerAwakeLine', () => {
  const realSetInterval = globalThis.setInterval;
  let ticks: number;
  let renderer: ReactTestRenderer | null = null;
  let lines: Array<ComputerAwakeLine | null>;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    globalThis.setInterval = realSetInterval;
  });

  function Probe({ awake, turnRunning }: { awake: { until: Date; capAt: Date } | null; turnRunning: boolean }) {
    lines.push(useComputerAwakeLine(awake, turnRunning));
    return null;
  }

  function mount(awake: { until: Date; capAt: Date } | null, turnRunning = false) {
    ticks = 0;
    lines = [];
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === COMPUTER_AWAKE_TICK_MS) ticks += 1;
      return realSetInterval(fn, ms);
    }) as typeof setInterval;
    act(() => {
      renderer = create(<Probe awake={awake} turnRunning={turnRunning} />);
    });
  }

  const windowOf = (untilMin: number, capMin: number) => ({
    until: new Date(Date.now() + untilMin * 60_000),
    capAt: new Date(Date.now() + capMin * 60_000),
  });

  test('no window, or a running turn: no clock', () => {
    mount(null);
    expect(ticks).toBe(0);
    expect(lines.at(-1)).toBeNull();
    act(() => renderer!.unmount());
    mount(windowOf(15, 100.5), true);
    expect(ticks).toBe(0);
    expect(lines.at(-1)).toBeNull();
  });

  test('a window: one clock, and the line keeps its identity until its text changes', () => {
    mount(windowOf(15, 100.5));
    expect(ticks).toBe(1);
    const first = lines.at(-1);
    expect(first).toEqual({ kind: 'stays', minutes: 100 });
    // A new response with the same window: new Date objects, the same text.
    act(() => renderer!.update(<Probe awake={windowOf(15, 100.5)} turnRunning={false} />));
    expect(lines.at(-1)).toBe(first!);
    act(() => renderer!.update(<Probe awake={windowOf(15, 50.5)} turnRunning={false} />));
    expect(lines.at(-1)).toEqual({ kind: 'stays', minutes: 50 });
    expect(ticks).toBe(1);
  });
});
