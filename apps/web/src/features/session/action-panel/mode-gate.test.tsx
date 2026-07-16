import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import type { PanelMode } from '@/stores/user-preferences-store';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';
import { ActionPanel, shouldDiscardPendingPrimaryOpen } from './index';

// `EasyPanel` calls `useSessionAudit` (react-query) unconditionally for its
// Terminal/Audit footer row's pending-count pill — `enabled: false` when no
// projectId/projectSessionId is passed (as none of these tests pass one), but
// the hook still needs a `QueryClientProvider` ancestor even though no query
// actually fires under a static render (same requirement as
// `show-tool.test.tsx`'s `useFileContent`).
function withQueryClient(node: ReactNode) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

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
      withQueryClient(<ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />),
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test("panelMode: 'easy' renders the Easy card home", () => {
    mockPanelMode = 'easy';
    const html = renderToStaticMarkup(
      withQueryClient(<ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />),
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test("panelMode: 'advanced' renders the stepper through ActionPanel, not the Easy card home", () => {
    mockPanelMode = 'advanced';
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        {withQueryClient(<ActionPanel sessionId="s1" messages={[]} isSessionBusy={false} />)}
      </NextIntlClientProvider>,
    );
    expect(html).not.toContain('Outputs');
    expect(html).not.toContain('Context');
  });

  test('EasyPanel renders the card home — Progress/Outputs/Context promises, no stepper', () => {
    const html = renderToStaticMarkup(
      withQueryClient(<EasyPanel sessionId="s1" messages={[]} isSessionBusy={false} />),
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

describe('EasyPanel Terminal/Audit footer row (PanelQuickNav)', () => {
  test('Terminal always renders; Audit is absent without projectId/projectSessionId', () => {
    const html = renderToStaticMarkup(
      withQueryClient(<EasyPanel sessionId="s1" messages={[]} isSessionBusy={false} />),
    );
    expect(html).toContain('Terminal');
    expect(html).not.toContain('Audit');
  });

  test('Audit renders once projectId && projectSessionId are both known', () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        <EasyPanel
          sessionId="s1"
          messages={[]}
          isSessionBusy={false}
          projectId="p1"
          projectSessionId="ps1"
        />,
      ),
    );
    expect(html).toContain('Terminal');
    expect(html).toContain('Audit');
  });
});

// ─── IMPORTANT 7 — a chip's pending "open with primary" request left
// standing while the user is in Advanced mode must not survive a later
// switch back to Easy mode and auto-open a deliverable out of nowhere.
// `ActionPanel`'s effect can't be exercised under `renderToStaticMarkup`
// (SSR never runs effects — see the file header), so this covers the
// extracted pure predicate directly, plus the store mechanic it drives. ──
describe('shouldDiscardPendingPrimaryOpen (W7)', () => {
  test('discards only in Advanced mode, and only for the matching session', () => {
    expect(shouldDiscardPendingPrimaryOpen('advanced', 's1', 's1')).toBe(true);
    expect(shouldDiscardPendingPrimaryOpen('easy', 's1', 's1')).toBe(false);
    expect(shouldDiscardPendingPrimaryOpen('advanced', 's1', 's2')).toBe(false);
    expect(shouldDiscardPendingPrimaryOpen('advanced', null, 's1')).toBe(false);
  });

  test('end to end: Advanced mode consumes this session\'s pending request via the store', () => {
    useKortixComputerStore.getState().reset();
    useKortixComputerStore.getState().requestPrimaryOpen('s1');
    expect(
      shouldDiscardPendingPrimaryOpen(
        'advanced',
        useKortixComputerStore.getState().pendingPrimaryOpenSessionId,
        's1',
      ),
    ).toBe(true);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(true);
    expect(useKortixComputerStore.getState().pendingPrimaryOpenSessionId).toBeNull();
  });
});
