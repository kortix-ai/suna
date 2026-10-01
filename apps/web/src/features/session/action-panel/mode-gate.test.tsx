import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';
import { ActionPanel } from './index';
import { SessionPanelContext, SessionPanelProvider, useOptionalSessionPanel, type SessionPanelValue } from './session-panel-provider';

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

// A mounted renderer runs child effects before provider effects, reproducing
// the lost-request race that server rendering cannot observe.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  innerWidth: 1440,
  matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
} });
afterAll(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow }));

describe('pending panel requests', () => {
  for (const mode of ['easy', 'advanced'] as const) {
    test(`${mode} preference opens the primary deliverable and palette quick views`, async () => {
      useKortixComputerStore.getState().reset();
      useUserPreferencesStore.getState().setPanelMode(mode);
      const opened: string[] = [];
      function Observe() {
        const panel = useOptionalSessionPanel();
        if (panel?.detail?.key && opened.at(-1) !== panel.detail.key) opened.push(panel.detail.key);
        if (panel?.terminalOpen && opened.at(-1) !== 'terminal') opened.push('terminal');
        return null;
      }
      const messages = [{
        info: {
          id: 'm1', sessionID: 's1', role: 'assistant' as const,
          time: { created: 1 }, parentID: 'u1', modelID: 'test', providerID: 'test',
          mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
          id: 'p1', sessionID: 's1', messageID: 'm1', type: 'tool' as const,
          tool: 'write', callID: 'c1', state: {
            status: 'completed' as const, input: { filePath: '/a/report.pdf' },
            output: '', title: '', metadata: {}, time: { start: 1, end: 2 },
          },
        }],
      }];
      let renderer: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(withQueryClient(
          <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
            <SessionPanelProvider sessionId="s1" messages={messages}>
              <ActionPanel /><Observe />
            </SessionPanelProvider>
          </NextIntlClientProvider>,
        ));
      });
      await act(async () => { useKortixComputerStore.getState().requestPrimaryOpen('s1'); });
      expect(opened).toContain('file:/a/report.pdf');
      await act(async () => { useKortixComputerStore.getState().requestQuickView('terminal', 's1'); });
      expect(opened).toContain('terminal');
      await act(async () => { renderer!.unmount(); });
    });
  }
});
