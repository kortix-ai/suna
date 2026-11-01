import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, useEffect, useState } from 'react';

import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { Toast } from './toast.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let active: TestRendererSetup | null = null;
afterEach(() => {
  active?.renderer.destroy();
  active = null;
});

/** A parent the test re-renders at will; each render passes a fresh arrow. */
let rerender: () => void = () => {};
function Busy({ onDismiss }: { onDismiss: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    rerender = () => setTick((value) => value + 1);
  }, []);
  return <Toast message="Renamed." timeoutMs={150} onDismiss={() => onDismiss()} />;
}

describe('Toast', () => {
  test('dismisses on time even while the parent re-renders with a new callback', async () => {
    const onDismiss = mock(() => {});
    active = await testRender(<Busy onDismiss={onDismiss} />, { width: 40, height: 6 });
    // 20 re-renders 20 ms apart: 400 ms, well past the 150 ms timeout.
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        rerender();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
