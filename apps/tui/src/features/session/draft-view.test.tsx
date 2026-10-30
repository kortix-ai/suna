import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { resetMouseDemandForTest } from '../../lib/mouse-demand.ts';
import { DraftView } from './draft-view.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let active: TestRendererSetup | null = null;
afterEach(() => {
  active?.renderer.destroy();
  active = null;
  resetMouseDemandForTest();
});

const BRAILLE = /[⠁-⣿]/;
const SYMBOL_TOP = '████      ████      ████';
const wait = (ms: number) =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

async function mount(): Promise<TestRendererSetup> {
  const setup = await testRender(
    <DraftView
      width={120}
      height={34}
      focused
      borderless
      context={{ hasProject: true, hasSession: false, hasAccount: true, capabilities: null }}
      splashLines={[{ label: '', value: 'TUI e2e · My workspace' }]}
      trayLeft="localhost · TUI e2e"
      onStart={async () => {}}
      onCommand={() => {}}
      onToast={() => {}}
    />,
    { width: 120, height: 34, useMouse: true },
  );
  active = setup;
  await setup.renderOnce();
  return setup;
}

/** Where the symbol's top row is on screen. */
function symbolCell(frame: string): { x: number; y: number } {
  const rows = frame.split('\n');
  const y = rows.findIndex((row) => row.includes(SYMBOL_TOP));
  return { x: (rows[y] ?? '').indexOf('█') + 2, y };
}

describe('the empty draft: a click on the symbol plays Game of Life', () => {
  test('a click starts it, a second click sends it back to the symbol', async () => {
    const setup = await mount();
    const resting = setup.captureCharFrame();
    const { x, y } = symbolCell(resting);
    expect(y).toBeGreaterThan(0);

    await act(async () => setup.mockMouse.click(x, y));
    await wait(1100);
    await setup.renderOnce();
    const living = setup.captureCharFrame();
    expect(living).toMatch(BRAILLE);
    expect(living).toContain('Type a prompt to start.');

    await act(async () => setup.mockMouse.click(x, y));
    await wait(2500);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain(SYMBOL_TOP);
  });

  test('a click on the input does not start it', async () => {
    const setup = await mount();
    const rows = setup.captureCharFrame().split('\n');
    const inputRow = rows.findIndex((row) => row.includes('What should Kortix do?'));
    await act(async () => setup.mockMouse.click(10, inputRow));
    await wait(1100);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toMatch(BRAILLE);
  });
});
