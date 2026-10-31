import { afterEach, describe, expect, test } from 'bun:test';
import { act, useEffect, useState } from 'react';

import { RGBA } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { theme } from '../theme.ts';
import { Splash, type SplashProps, splashHeight } from './splash.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let active: TestRendererSetup | null = null;
afterEach(() => {
  active?.renderer.destroy();
  active = null;
});

const SYMBOL_2X_TOP = '████      ████      ████';
const SYMBOL_2X_CURVE = '██████    ████    ██████';
const SYMBOL_1X_MID = '▀██▄ ██ ▄██▀';
const LINES = [
  { label: 'host', value: 'local  http://localhost:8008' },
  { label: 'project', value: '<project>' },
];
const BRAILLE = /[⠁-⣿]/;

async function render(node: React.ReactNode, width: number, height: number, useMouse = false) {
  active = await testRender(node, { width, height, useMouse });
  await active.renderOnce();
  return active;
}

const wait = (ms: number) =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

/** A parent that drives `lifeSignal` and mounting from the test. */
const control = { bump: () => {}, unmount: () => {} };
function Host(props: Omit<SplashProps, 'lifeSignal'>) {
  const [signal, setSignal] = useState(0);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    control.bump = () => setSignal((value) => value + 1);
    control.unmount = () => setMounted(false);
  }, []);
  return mounted ? <Splash {...props} lifeSignal={signal} /> : <text>gone</text>;
}

describe('Splash', () => {
  test('draws the 2× symbol, the tagline and the lines at 120 × 36, in monochrome', async () => {
    const setup = await render(
      <Splash width={120} height={36} center ambient tagline="Type a prompt." lines={LINES} />,
      120,
      36,
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain(SYMBOL_2X_TOP);
    expect(frame).toContain(SYMBOL_2X_CURVE);
    expect(frame).toContain('Type a prompt.');
    expect(frame).toContain('host    local  http://localhost:8008');
    expect(frame.split('\n')[0]).toMatch(BRAILLE);

    const brand = RGBA.fromHex(theme.brand);
    const colors = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.text.trim())
      .map((span) => span.fg);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.some((fg) => fg.equals(brand))).toBe(false);
  });

  test('fits 50 × 20 and falls back to 1× and to the word when narrow', async () => {
    let setup = await render(
      <Splash width={50} height={20} center tagline="Type a prompt." lines={LINES} />,
      50,
      20,
    );
    expect(setup.captureCharFrame()).toContain(SYMBOL_2X_TOP);
    setup.renderer.destroy();

    setup = await render(<Splash width={20} tagline="Type a prompt." lines={LINES} />, 20, 20);
    expect(setup.captureCharFrame()).toContain(SYMBOL_1X_MID);
    setup.renderer.destroy();

    setup = await render(<Splash width={12} tagline="Type a prompt." />, 12, 10);
    expect(setup.captureCharFrame()).toContain('kortix');
  });

  test('splashHeight is the row count the splash draws', async () => {
    for (const [width, ambient] of [
      [120, true],
      [120, false],
      [20, true],
    ] as const) {
      const setup = await render(
        <box flexDirection="column">
          <Splash width={width} tagline="Type a prompt." lines={LINES} ambient={ambient} />
          <text>END</text>
        </box>,
        width,
        40,
      );
      const rows = setup.captureCharFrame().split('\n');
      expect(rows.findIndex((row) => row.startsWith('END'))).toBe(
        splashHeight(width, LINES.length, true, ambient),
      );
      setup.renderer.destroy();
      active = null;
    }
  });

  test('ambient off draws no dither band', async () => {
    const setup = await render(
      <Splash width={80} tagline="Type a prompt." ambient={false} />,
      80,
      20,
    );
    expect(setup.captureCharFrame()).not.toMatch(BRAILLE);
  });

  test('a new lifeSignal starts Life over the splash area', async () => {
    const setup = await render(
      <Host width={120} height={36} center tagline="Type a prompt." lines={LINES} />,
      120,
      36,
    );
    const resting = setup.captureCharFrame();
    await act(async () => control.bump());
    // 6 hold frames, then a few generations at 12 fps.
    await wait(900);
    await setup.renderOnce();
    const living = setup.captureCharFrame();
    expect(living).not.toBe(resting);
    expect(living).not.toContain(SYMBOL_2X_TOP);
    // The hint stays put while Life runs: only the symbol comes alive.
    expect(living).toContain('Type a prompt.');
    // Life draws in braille dots once the wipe has swept the blocks away.
    expect(living).toMatch(BRAILLE);
  });

  test('turns the mouse on while mounted, a click on the symbol starts Life, unmount restores it', async () => {
    const setup = await render(
      <Host width={120} height={36} center tagline="Type a prompt." lines={LINES} />,
      120,
      36,
    );
    await act(async () => {});
    expect(setup.renderer.useMouse).toBe(true);

    const rows = setup.captureCharFrame().split('\n');
    const y = rows.findIndex((row) => row.includes(SYMBOL_2X_TOP));
    const x = rows[y].indexOf(SYMBOL_2X_TOP);
    await act(async () => setup.mockMouse.click(x + 1, y + 1));
    // Generation 0 holds the symbol unchanged for 0.5 s, then it evolves.
    await wait(900);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain(SYMBOL_2X_TOP);
    expect(frame).toMatch(BRAILLE);

    await act(async () => control.unmount());
    expect(setup.renderer.useMouse).toBe(false);
  });

  test('leaves the mouse on at unmount when the app started with it on', async () => {
    const setup = await render(<Host width={60} tagline="Type a prompt." />, 60, 24, true);
    await act(async () => control.unmount());
    expect(setup.renderer.useMouse).toBe(true);
  });
});

describe('Life starts exactly where the symbol rests', () => {
  // Odd free widths are the case Yoga centring and Math.floor disagreed on:
  // the symbol jumped one column left when Life began.
  for (const [width, height] of [
    [120, 30],
    [121, 30],
    [137, 30],
    [30, 16],
  ] as const) {
    test(`generation 0 equals the resting frame, glyph for glyph, at ${width} × ${height}`, async () => {
      const setup = await render(
        <Host
          width={width}
          height={height}
          center
          tagline="Type a prompt."
          lines={[{ label: '', value: 'TUI e2e' }]}
        />,
        width,
        height,
      );
      await setup.renderOnce();
      const resting = setup.captureCharFrame();
      await act(async () => control.bump());
      await setup.renderOnce();
      // The hold: Life is mounted but has not stepped yet.
      const generation0 = setup.captureCharFrame();
      expect(generation0).toBe(resting);
    });
  }
});
