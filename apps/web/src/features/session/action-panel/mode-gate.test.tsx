import { describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PanelMode } from '@/stores/user-preferences-store';
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
 * regardless of any `setState` call made in the test body.
 *
 * So instead this file mocks the store module itself (`mock.module`) with a
 * plain callable `(selector) => selector(state)` stand-in, and drives
 * `state.preferences.panelMode` per test. This is a genuine fallback test:
 * `mockPanelMode = undefined` below reproduces exactly what a pre-panelMode
 * persisted store looks like, and exercises the `?? 'easy'` coalesce inside
 * `ActionPanel` for real — not a copy of the store's own default.
 *
 * `mock.module` is file-global in Bun (it patches the shared module
 * registry for the rest of this file's run), so every `ActionPanel` test in
 * this file goes through this same mock rather than mixing mocked and
 * unmocked reads of the store.
 *
 * `AdvancedPanel` still can't be exercised directly under
 * `renderToStaticMarkup` without a `NextIntlClientProvider` ancestor (it
 * calls `useTranslations('hardcodedUi')`), so the advanced-mode case renders
 * `ActionPanel` wrapped in the provider instead of calling `AdvancedPanel`
 * directly.
 */

let mockPanelMode: PanelMode | undefined;

mock.module('@/stores/user-preferences-store', () => ({
  useUserPreferencesStore: (
    selector: (state: { preferences: { panelMode: PanelMode | undefined } }) => unknown,
  ) => selector({ preferences: { panelMode: mockPanelMode } }),
}));

describe('panel mode gate', () => {
  test('missing panelMode (pre-panelMode persisted state) falls back to Easy', () => {
    mockPanelMode = undefined;
    const html = renderToStaticMarkup(
      <ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />,
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test("panelMode: 'easy' renders the Easy card home", () => {
    mockPanelMode = 'easy';
    const html = renderToStaticMarkup(
      <ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />,
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test("panelMode: 'advanced' renders the stepper through ActionPanel, not the Easy card home", () => {
    mockPanelMode = 'advanced';
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />
      </NextIntlClientProvider>,
    );
    expect(html).not.toContain('Outputs');
    expect(html).not.toContain('Context');
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
