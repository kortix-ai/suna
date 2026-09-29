import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';
import { ActionPanel } from './index';
import { SessionPanelContext, type SessionPanelValue } from './session-panel-provider';

// The cards read everything from `SessionPanelProvider`. Standing the real one
// up here would drag in the sandbox proxy, react-query and four stores for
// behavior these tests are not about, so they inject a stub value straight
// into the context instead — the seam the provider split exists to give.
function withPanel(node: ReactNode, over: Partial<SessionPanelValue> = {}) {
  const value = {
    sessionId: 's1',
    files: [],
    context: { files: [], web: [], tools: [] },
    apps: [],
    outputsDefaultOpen: false,
    detail: null,
    terminalOpen: false,
    terminalSwap: false,
    openDetail: () => {},
    handleOpenOutput: () => {},
    closeDetail: () => {},
    openTerminal: () => {},
    closeTerminal: () => {},
    openBrowser: () => {},
    openFiles: () => {},
    openAudit: () => {},
    ...over,
  } as SessionPanelValue;
  return <SessionPanelContext.Provider value={value}>{node}</SessionPanelContext.Provider>;
}

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

describe('panel mode gate', () => {
  test('ActionPanel renders the Easy card home even when Advanced is disabled', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        {withQueryClient(withPanel(<ActionPanel />))}
      </NextIntlClientProvider>,
    );
    // No preference read: a persisted Advanced preference cannot change this render.
    expect(html).toContain('Outputs');
    expect(html).toContain('Context');
  });

  test('EasyPanel renders the card home — Outputs/Context promises, no stepper', () => {
    const html = renderToStaticMarkup(withQueryClient(withPanel(<EasyPanel />)));
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

// The Terminal/Audit footer row (PanelQuickNav) was removed by owner
// direction — Terminal moved to the session header (icon-only, see
// session-site-header.tsx), Audit stays reachable via the command palette.
// This pins the removal: the Easy home renders NO quick-nav labels.
describe('EasyPanel home has no Terminal/Audit footer row', () => {
  test('neither label renders in the card column', () => {
    const html = renderToStaticMarkup(
      withQueryClient(withPanel(<EasyPanel />, { projectSessionId: 'ps1' })),
    );
    expect(html).not.toContain('>Terminal<');
    expect(html).not.toContain('>Audit<');
  });
});

// Static rendering cannot run effects. Pin the handoff ownership here until
// the local browser suite can exercise a mounted provider with a real session.
describe('pending panel requests', () => {
  test('ActionPanel never consumes requests ahead of its provider', () => {
    const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('consumePrimaryOpen(');
    expect(source).not.toContain('consumeQuickView(');
  });

  test('the primary-open request remains one-shot for its own session', () => {
    useKortixComputerStore.getState().reset();
    useKortixComputerStore.getState().requestPrimaryOpen('s1');
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s2')).toBe(false);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(true);
    expect(useKortixComputerStore.getState().consumePrimaryOpen('s1')).toBe(false);
    expect(useKortixComputerStore.getState().pendingPrimaryOpenSessionId).toBeNull();
  });
});
