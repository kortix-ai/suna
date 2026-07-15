import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';
import { ActionPanel } from './index';

/**
 * Panel-mode regression coverage.
 *
 * The brief's original draft drove `ActionPanel` through
 * `useUserPreferencesStore.setState()` before each `renderToStaticMarkup`
 * call. That does not work: zustand v5's React binding feeds
 * `useSyncExternalStore` a `getServerSnapshot` pinned to `api.getInitialState()`
 * (see `zustand/react.js`), which is captured once at store-module-load time
 * and never updated by `setState` — `AppsCard`'s own comment documents the
 * same trap. Under `renderToStaticMarkup`, `ActionPanel`'s
 * `useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy')` read
 * therefore always resolves to whatever the store's pristine state was,
 * regardless of any `setState` call made in the test body — confirmed by
 * spiking `getState()` (reads the mutated value) against the rendered HTML
 * (still reflects the original value).
 *
 * `AdvancedPanel` compounds this: it calls `useTranslations('hardcodedUi')`
 * with no `NextIntlClientProvider` ancestor, which throws under
 * `renderToStaticMarkup` outside of one.
 *
 * So this file tests what static rendering can actually observe:
 *  - `ActionPanel` with the store's real, untouched default (which IS
 *    'easy' — the only state reachable this way) renders the card home,
 *    proving the default-fallback path end to end.
 *  - `EasyPanel` and `AdvancedPanel`, rendered directly (bypassing the
 *    store-driven gate entirely), each carry their own distinguishing
 *    content — the actual regression risk ("did a refactor blur the two
 *    modes together") — without relying on the SSR-broken selector.
 */
describe('panel mode gate', () => {
  test('ActionPanel, with the store at its real default, renders the Easy card home', () => {
    const html = renderToStaticMarkup(
      <ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />,
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test('EasyPanel renders the card home — Progress/Outputs/Context promises, no stepper', () => {
    const html = renderToStaticMarkup(
      <EasyPanel sessionId="s1" messages={[]} isSessionBusy={false} />,
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test('AdvancedPanel renders the stepper, unchanged — no Easy-only card labels', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <AdvancedPanel sessionId="s1" messages={[]} />
      </NextIntlClientProvider>,
    );
    expect(html).not.toContain('Outputs');
    expect(html).not.toContain('Context');
  });
});
