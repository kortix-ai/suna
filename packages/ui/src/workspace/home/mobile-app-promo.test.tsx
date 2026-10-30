import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  NodeFilter: browser.NodeFilter,
  MutationObserver: browser.MutationObserver,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  HTMLInputElement: browser.HTMLInputElement,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}

const { MobileAppPromo } = await import('./mobile-app-promo');
const { useMobileAppPromoStore } = await import('../../internal/stores/mobile-app-promo-store');
const { IntlTestProvider } = await import('../../test-utils/intl');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);

async function renderAt(width: number) {
  browser.happyDOM.setWindowSize({ width, height: 900 });
  await act(async () =>
    root.render(
      <IntlTestProvider>
        <MobileAppPromo />
      </IntlTestProvider>,
    ),
  );
}

afterEach(async () => {
  await act(async () => root.render(null));
  useMobileAppPromoStore.setState({ closed: false });
  localStorage.clear();
});
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('desktop project loads do not open the mobile promo or mark it dismissed', async () => {
  await renderAt(1440);
  expect(document.querySelector('[role="dialog"]') !== null).toBe(false);
  expect(useMobileAppPromoStore.getState().closed).toBe(false);
});

test('mobile dismissal persists when the promo remounts', async () => {
  await renderAt(390);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const close = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Close',
  );
  expect(close).toBeInstanceOf(HTMLElement);
  await act(async () => {
    if (close instanceof HTMLElement) close.click();
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(useMobileAppPromoStore.getState().closed).toBe(true);
  expect(localStorage.getItem('kortix.mobileAppPromo')).toContain('"closed":true');
  await act(async () => root.render(null));
  await useMobileAppPromoStore.persist.rehydrate();
  await renderAt(390);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
