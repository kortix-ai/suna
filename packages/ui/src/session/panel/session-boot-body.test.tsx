import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';

import type { SessionPanelValue } from './session-panel-provider';

/**
 * While a session's computer boots, the Terminal, Browser and Files cards wear
 * their real chrome over the wake status, and mount nothing that reaches the
 * sandbox. Rendered for real (react-dom on happy-dom). The DOM globals exist
 * before any UI module loads, hence the dynamic imports in `beforeAll`.
 */
const OVERRIDE = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage'];
const saved: Record<string, unknown> = {};

let m: {
  act: typeof import('react').act;
  createRoot: typeof import('react-dom/client').createRoot;
  QueryClient: typeof import('@tanstack/react-query').QueryClient;
  QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider;
  UiProvider: typeof import('../../providers/ui-provider').UiProvider;
  SessionPanelContext: typeof import('./session-panel-provider').SessionPanelContext;
  SessionBootGate: typeof import('./session-panel-provider').SessionBootGate;
  SessionDetailPanel: typeof import('./session-detail-panel').SessionDetailPanel;
  SessionFilesBooting: typeof import('./session-files-explorer').SessionFilesBooting;
  AppPreviewBooting: typeof import('./easy/app-preview').AppPreviewBooting;
  SessionBootStatus: typeof import('../status/session-starting-loader').SessionBootStatus;
};

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  const keys = [...OVERRIDE, ...Object.getOwnPropertyNames(w).filter((k) => !(k in g))];
  for (const key of keys) {
    saved[key] = g[key];
    g[key] = key === 'window' ? win : w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const query = await import('@tanstack/react-query');
  const provider = await import('./session-panel-provider');
  m = {
    act: (await import('react')).act,
    createRoot: (await import('react-dom/client')).createRoot,
    QueryClient: query.QueryClient,
    QueryClientProvider: query.QueryClientProvider,
    UiProvider: (await import('../../providers/ui-provider')).UiProvider,
    SessionPanelContext: provider.SessionPanelContext,
    SessionBootGate: provider.SessionBootGate,
    SessionDetailPanel: (await import('./session-detail-panel')).SessionDetailPanel,
    SessionFilesBooting: (await import('./session-files-explorer')).SessionFilesBooting,
    AppPreviewBooting: (await import('./easy/app-preview')).AppPreviewBooting,
    SessionBootStatus: (await import('../status/session-starting-loader')).SessionBootStatus,
  };
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

let root: ReturnType<typeof import('react-dom/client').createRoot> | null = null;
afterEach(async () => {
  await m.act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const noop = () => {};

function panelValue(overrides: Partial<SessionPanelValue>): SessionPanelValue {
  return {
    sessionId: 'route-session',
    files: [],
    context: [] as unknown as SessionPanelValue['context'],
    apps: [],
    outputsDefaultOpen: false,
    detail: null,
    terminalOpen: false,
    terminalSwap: false,
    openDetail: noop,
    handleOpenOutput: noop,
    closeDetail: noop,
    openTerminal: noop,
    closeTerminal: noop,
    openBrowser: noop,
    openFiles: noop,
    openAudit: noop,
    openReminders: noop,
    ...overrides,
  };
}

const client = () => new m.QueryClient({ defaultOptions: { queries: { retry: false } } });

async function render(value: SessionPanelValue, node: ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const queryClient = client();
  const tree = (v: SessionPanelValue) => (
    <m.QueryClientProvider client={queryClient}>
      <m.UiProvider>
        <m.SessionPanelContext.Provider value={v}>{node}</m.SessionPanelContext.Provider>
      </m.UiProvider>
    </m.QueryClientProvider>
  );
  await m.act(async () => {
    root = m.createRoot(host);
    root.render(tree(value));
  });
  return {
    host,
    rerender: (v: SessionPanelValue) => m.act(async () => root?.render(tree(v))),
  };
}

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  );

describe('tool cards while the session boots', () => {
  test('no card open: the panel shows the wake status, never a blank panel', async () => {
    const { host } = await render(panelValue({ booting: true }), <m.SessionDetailPanel />);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
  });

  test('Terminal: the real card header, the wake status, a working Close, no shell', async () => {
    let closed = 0;
    const { host } = await render(
      panelValue({ booting: true, terminalOpen: true, closeTerminal: () => closed++ }),
      <m.SessionDetailPanel />,
    );
    expect(host.textContent).toContain('Terminal');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
    expect(host.querySelector('.xterm')).toBeNull();
    const close = button(host, 'Close');
    expect(close?.disabled).toBe(false);
    await m.act(async () => close?.click());
    expect(closed).toBe(1);
  });

  test('Browser: the toolbar is drawn, disabled where it needs the computer; Close works', async () => {
    let closed = 0;
    const { host } = await render(
      panelValue({ booting: true }),
      <m.AppPreviewBooting onClose={() => closed++}>
        <m.SessionBootStatus />
      </m.AppPreviewBooting>,
    );
    const address = host.querySelector('input');
    expect(address?.placeholder).toBe('Type a port, e.g. 3000');
    expect(address?.disabled).toBe(true);
    for (const label of ['Home', 'Refresh', 'Open in a new tab']) {
      expect(button(host, label)?.disabled).toBe(true);
    }
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
    await m.act(async () => button(host, 'Close')?.click());
    expect(closed).toBe(1);
  });

  test('Files on All files: tabs, New and View options drawn disabled', async () => {
    const { host } = await render(
      panelValue({ booting: true }),
      <m.SessionFilesBooting mode="files">
        <m.SessionBootStatus />
      </m.SessionFilesBooting>,
    );
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['All files', 'Changes']);
    expect(tabs.every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(button(host, 'New')?.disabled).toBe(true);
    expect(button(host, 'View options')?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
  });

  test('Files on Changes: only the disabled tabs, like the live Changes card; turns live without reopening', async () => {
    const body = (
      <m.SessionBootGate
        boot={
          <m.SessionFilesBooting mode="changes">
            <m.SessionBootStatus />
          </m.SessionFilesBooting>
        }
      >
        <p data-testid="live-explorer">live</p>
      </m.SessionBootGate>
    );
    const { host, rerender } = await render(panelValue({ booting: true }), body);
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['All files', 'Changes']);
    expect(tabs.every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(button(host, 'New')).toBeUndefined();
    expect(button(host, 'View options')).toBeUndefined();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
    expect(host.querySelector('[data-testid="live-explorer"]')).toBeNull();

    // The computer comes up: the same card body is now the live explorer.
    await rerender(panelValue({ booting: false }));
    expect(host.querySelector('[data-testid="live-explorer"]')).not.toBeNull();
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });
});
