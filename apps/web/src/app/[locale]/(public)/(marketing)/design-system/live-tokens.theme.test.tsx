import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { useIsDark } from './live-tokens';

const saved = Object.getOwnPropertyDescriptors(globalThis);
afterEach(() => {
  for (const name of ['window', 'document', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    const descriptor = saved[name];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function Probe() {
  return <span>{useIsDark() ? 'dark' : 'light'}</span>;
}
test('server rendering starts light', () => {
  expect(renderToString(<Probe />)).toBe('<span>light</span>');
});
test('root theme toggles update the reader and unmount disconnects its observer', async () => {
  const win = new Window();
  let disconnected = 0;
  class Observer extends win.MutationObserver {
    disconnect() { disconnected++; super.disconnect(); }
  }
  for (const [name, value] of Object.entries({ window: win, document: win.document, MutationObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe('light');
    await act(async () => { win.document.documentElement.classList.add('dark'); await win.happyDOM.whenAsyncComplete(); });
    expect(host.textContent).toBe('dark');
    await act(async () => { win.document.documentElement.classList.remove('dark'); await win.happyDOM.whenAsyncComplete(); });
    expect(host.textContent).toBe('light');
  } finally {
    await act(async () => root.unmount());
    expect(disconnected).toBe(1);
    await win.happyDOM.close();
  }
});
