import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { UseSessionResult } from '@kortix/sdk/react';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';

/**
 * A host that renders `SessionThread` alone has no side panel. The thread's
 * "open in the panel" actions must still open something: the fallback overlay
 * that `SessionThread` mounts. Rendered for real (react-dom on happy-dom), so a
 * click on the actual Preview button is what opens it.
 *
 * The DOM globals exist before any UI module loads: Radix decides at import
 * time whether layout effects run, and without a document its portals never
 * mount. Hence the dynamic imports in `beforeAll`.
 */
// Overridden even where Bun has its own: React and Radix must see happy-dom's.
const OVERRIDE = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage'];
const saved: Record<string, unknown> = {};

let m: {
  act: typeof import('react').act;
  createRoot: typeof import('react-dom/client').createRoot;
  QueryClient: typeof import('@tanstack/react-query').QueryClient;
  QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider;
  UiProvider: typeof import('../../providers/ui-provider').UiProvider;
  SessionThread: typeof import('../thread/session-thread').SessionThread;
  ShowFileActions: typeof import('../tool/shared/show-helpers').ShowFileActions;
  openSessionQuickView: typeof import('./open-session-quick-view').openSessionQuickView;
  useFilePreviewStore: typeof import('../../internal/stores/file-preview-store').useFilePreviewStore;
  useKortixComputerStore: typeof import('../../internal/stores/kortix-computer-store').useKortixComputerStore;
  usePanelFallbackStore: typeof import('../../internal/stores/panel-fallback-store').usePanelFallbackStore;
  useSessionBrowserStore: typeof import('../../internal/stores/session-browser-store').useSessionBrowserStore;
};

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  // Every DOM name Bun lacks (NodeFilter, customElements, …) plus the overrides.
  const keys = [...OVERRIDE, ...Object.getOwnPropertyNames(w).filter((k) => !(k in g))];
  for (const key of keys) {
    saved[key] = g[key];
    g[key] = key === 'window' ? win : w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const query = await import('@tanstack/react-query');
  m = {
    act: (await import('react')).act,
    createRoot: (await import('react-dom/client')).createRoot,
    QueryClient: query.QueryClient,
    QueryClientProvider: query.QueryClientProvider,
    UiProvider: (await import('../../providers/ui-provider')).UiProvider,
    SessionThread: (await import('../thread/session-thread')).SessionThread,
    ShowFileActions: (await import('../tool/shared/show-helpers')).ShowFileActions,
    openSessionQuickView: (await import('./open-session-quick-view')).openSessionQuickView,
    useFilePreviewStore: (await import('../../internal/stores/file-preview-store')).useFilePreviewStore,
    useKortixComputerStore: (await import('../../internal/stores/kortix-computer-store')).useKortixComputerStore,
    usePanelFallbackStore: (await import('../../internal/stores/panel-fallback-store')).usePanelFallbackStore,
    useSessionBrowserStore: (await import('../../internal/stores/session-browser-store')).useSessionBrowserStore,
  };
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  document.body.innerHTML = '';
  m.useFilePreviewStore.getState().closePreview();
  m.usePanelFallbackStore.setState({ request: null });
  m.useSessionBrowserStore.getState().setActiveSessionId(null);
});

async function mount(node: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = m.createRoot(container);
  await m.act(async () => {
    root.render(
      <m.QueryClientProvider client={new m.QueryClient()}>
        <m.UiProvider>{node}</m.UiProvider>
      </m.QueryClientProvider>,
    );
  });
  unmount = async () => m.act(async () => root.unmount());
}

/** Wait for lazy code and portals to paint. */
async function waitFor(selector: string) {
  for (let i = 0; i < 100 && !document.querySelector(selector); i++) {
    await m.act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  return document.querySelector(selector);
}

// Before the runtime has an id: the thread shows its starting state, and no panel exists.
const session = { projectId: 'p1', sessionId: 's1', runtimeSessionId: null, stage: 'provisioning' } as unknown as UseSessionResult;

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found as HTMLButtonElement;
}

describe('SessionThread without a side panel', () => {
  test("a show card's Preview click opens the file preview", async () => {
    await mount(
      <>
        <m.SessionThread session={session} />
        <m.ShowFileActions path="/workspace/notes.md" />
      </>,
    );
    expect(m.usePanelFallbackStore.getState().hosts).toBe(1);
    await m.act(async () => button('Preview').click());
    expect(m.useFilePreviewStore.getState()).toMatchObject({ isOpen: true, filePath: '/workspace/notes.md' });
    // The dialog code loads on the first open.
    expect(await waitFor('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('notes.md');
  });

  test('a Browser intent opens the fallback overlay, not the absent panel', async () => {
    await mount(<m.SessionThread session={session} />);
    await m.act(async () =>
      m.openSessionQuickView('browser', 'preview', { url: 'http://localhost:3000', title: 'App' }),
    );
    expect(m.usePanelFallbackStore.getState().request).toEqual({
      view: 'browser',
      target: { url: 'http://localhost:3000', title: 'App' },
    });
    expect(await waitFor('[data-slot="session-panel-fallback"]')).not.toBeNull();
    expect(m.useKortixComputerStore.getState().pendingQuickView).toBeNull();
  });

  test('with a side panel mounted, the panel stays the one destination', async () => {
    await mount(<m.SessionThread session={session} />);
    await m.act(async () => m.useSessionBrowserStore.getState().setActiveSessionId('ses_1'));
    await m.act(async () => m.openSessionQuickView('terminal', 'header'));
    expect(m.usePanelFallbackStore.getState().request).toBeNull();
    expect(m.useKortixComputerStore.getState().pendingQuickView).toMatchObject({ sessionId: 'ses_1', view: 'terminal' });
    expect(document.querySelector('[data-slot="session-panel-fallback"]')).toBeNull();
  });
});
