import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const win = new Window();
const dom = win as unknown as Record<string, unknown>;
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'KeyboardEvent',
  'customElements',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = dom[key];
  Object.defineProperty(globalThis, key, {
    value: typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(win) : value,
    configurable: true,
  });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const { DetailLayer } = await import('./detail-view');

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mountDetail() {
  const onBack = mock(() => undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DetailLayer detail={{ key: 'k', title: 'image.png', body: <div /> }} onBack={onBack} isMobile={false}>
        <div>home</div>
      </DetailLayer>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { onBack };
}

describe('detail layer Escape', () => {
  /**
   * The page-wide triple-ESC-to-stop (`session-chat.tsx`) skips an Escape
   * another control marked consumed. Closing three full-screen images in a
   * row used to stop the running turn because this close left the press
   * unmarked.
   */
  test('closing the detail marks the press consumed', () => {
    const { onBack } = mountDetail();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
