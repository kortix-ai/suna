import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const overrides = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage'];
const saved: Record<string, unknown> = {};
let m: {
  act: typeof import('react').act;
  useState: typeof import('react').useState;
  createRoot: typeof import('react-dom/client').createRoot;
  QueryClient: typeof import('@tanstack/react-query').QueryClient;
  QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider;
  UiProvider: typeof import('../../providers/ui-provider').UiProvider;
  MobileToolDrawer: typeof import('./mobile-tool-drawer').MobileToolDrawer;
  SessionPanelContext: typeof import('./session-panel-provider').SessionPanelContext;
  open: typeof import('./open-session-quick-view').openSessionQuickView;
  store: typeof import('../../internal/stores/kortix-computer-store').useKortixComputerStore;
  tabs: typeof import('../../internal/stores/tab-store').useTabStore;
};
let root: ReturnType<typeof import('react-dom/client').createRoot> | undefined;
let client: InstanceType<typeof import('@tanstack/react-query').QueryClient> | undefined;
const projectId = '00000000-0000-4000-8000-000000000001';
const artifactA = '00000000-0000-4000-8000-000000000002';
const artifactB = '00000000-0000-4000-8000-000000000003';
const artifactUrl = (id: string) => `https://example.test/projects/${projectId}/artifacts/${id}`;

beforeAll(async () => {
  const win = new Window({ url: 'https://example.test/', width: 720, height: 480 });
  const global = globalThis as Record<string, unknown>;
  const browser = win as unknown as Record<string, unknown>;
  for (const key of [...overrides, ...Object.getOwnPropertyNames(browser).filter(key => !(key in global))]) {
    saved[key] = global[key];
    global[key] = key === 'window' ? win : browser[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  const query = await import('@tanstack/react-query');
  m = {
    act: react.act,
    useState: react.useState,
    createRoot: (await import('react-dom/client')).createRoot,
    QueryClient: query.QueryClient,
    QueryClientProvider: query.QueryClientProvider,
    UiProvider: (await import('../../providers/ui-provider')).UiProvider,
    MobileToolDrawer: (await import('./mobile-tool-drawer')).MobileToolDrawer,
    SessionPanelContext: (await import('./session-panel-provider')).SessionPanelContext,
    open: (await import('./open-session-quick-view')).openSessionQuickView,
    store: (await import('../../internal/stores/kortix-computer-store')).useKortixComputerStore,
    tabs: (await import('../../internal/stores/tab-store')).useTabStore,
  };
});

afterEach(async () => {
  await m.act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  document.body.innerHTML = '';
  m.store.getState().reset();
});

afterAll(() => {
  const global = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete global[key];
    else global[key] = value;
  }
});

function Viewer({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const [draft, setDraft] = m.useState('');
  return <section data-host-artifact={artifactId}>
    <input aria-label="Owned draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button onClick={() => setDraft('A private draft')}>Edit owned draft</button>
    <button onClick={onClose}>Close owned Artifact</button>
  </section>;
}

function drawer(sessionId = 'session-a', booting = false) {
  const value = { booting } as import('./session-panel-provider').SessionPanelValue;
  return (
    <m.QueryClientProvider client={client!}>
      <m.UiProvider components={{ ArtifactViewer: Viewer }}>
        <m.SessionPanelContext.Provider value={value}>
          <m.MobileToolDrawer sessionId={sessionId} />
        </m.SessionPanelContext.Provider>
      </m.UiProvider>
    </m.QueryClientProvider>
  );
}

async function mount(booting = false) {
  m.store.getState().setActiveSession('session-a');
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = m.createRoot(container);
  client = new m.QueryClient({ defaultOptions: { queries: { retry: false } } });
  await m.act(async () => root!.render(drawer('session-a', booting)));
}

test('720px Artifact intent renders the registered Viewer while its session is booting', async () => {
  await mount(true);
  await m.act(async () => m.open('browser', 'chat', { url: artifactUrl(artifactA), title: 'Owned A' }));
  expect(m.store.getState().mobileToolTarget?.url).toBe(artifactUrl(artifactA));
  expect(document.querySelector(`[data-host-artifact="${artifactA}"]`)).not.toBeNull();
  expect(m.store.getState().pendingQuickView).toBeNull();
});

test('actual drawer target replacement drops A draft, and close or session switch clears its target', async () => {
  await mount();
  await m.act(async () => m.open('browser', 'chat', { url: artifactUrl(artifactA) }));
  expect(document.querySelector('[data-host-artifact]')).not.toBeNull();
  await m.act(async () => (document.querySelector('[data-host-artifact] button') as HTMLButtonElement).click());
  expect((document.querySelector('input[aria-label="Owned draft"]') as HTMLInputElement).value).toBe('A private draft');
  await m.act(async () => m.open('browser', 'chat', { url: artifactUrl(artifactB) }));
  expect(document.querySelector(`[data-host-artifact="${artifactA}"]`)).toBeNull();
  expect((document.querySelector('input[aria-label="Owned draft"]') as HTMLInputElement).value).toBe('');
  await m.act(async () => (document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
  expect(m.store.getState().mobileToolView).toBeNull();
  expect(m.store.getState().mobileToolTarget).toBeNull();
  await m.act(async () => m.open('browser', 'chat', { url: artifactUrl(artifactA) }));
  await m.act(async () => m.store.getState().setActiveSession('session-b'));
  expect(m.store.getState().mobileToolView).toBeNull();
  expect(m.store.getState().mobileToolTarget).toBeNull();
});

test('ordinary mobile Browser URL uses the existing BrowserPanel navigation and address', async () => {
  await mount();
  const url = 'https://www.example.test/owned-preview';
  await m.act(async () => m.open('browser', 'chat', { url }));
  expect(document.querySelector('[data-host-artifact]')).toBeNull();
  expect(m.tabs.getState().tabs['session-preview:session-a']?.metadata?.originalUrl).toBe(url);
  expect([...document.querySelectorAll('input')].map(input => input.value)).toContain(url);
  const tab = m.tabs.getState().tabs['session-preview:session-a'];
  await m.act(async () => m.open('browser', 'chat', { url }));
  expect(m.tabs.getState().tabs['session-preview:session-a']).toBe(tab);
  const next = 'https://www.example.test/another-preview';
  await m.act(async () => m.open('browser', 'chat', { url: next }));
  expect(m.tabs.getState().tabs['session-preview:session-a']?.metadata?.originalUrl).toBe(next);
  expect([...document.querySelectorAll('input')].map(input => input.value)).toContain(next);
});

test('an already prepared proxy target preserves its Browser metadata without wrapping it again', async () => {
  const url = 'https://preview.example.test/p/synthetic/3000/owned';
  const metadata = { url, originalUrl: 'http://localhost:3000/owned', port: 3000, path: '/owned' };
  m.tabs.getState().openTab({ id: 'session-preview:session-a', title: 'Owned app', type: 'preview', href: '/', metadata });
  await mount();
  await m.act(async () => m.open('browser', 'chat', { url }));
  expect(m.tabs.getState().tabs['session-preview:session-a']?.metadata).toEqual(metadata);
  expect([...document.querySelectorAll('input')].map(input => input.value)).toContain(metadata.originalUrl);
});

test('a retained Browser applies the same URL to the new session tab after a batched switch', async () => {
  await mount();
  const url = 'https://www.example.test/shared-target';
  await m.act(async () => m.open('browser', 'chat', { url }));
  const previous = m.tabs.getState().tabs['session-preview:session-a'];
  expect(previous?.metadata?.originalUrl).toBe(url);
  await m.act(async () => {
    m.store.getState().setActiveSession('session-b');
    m.open('browser', 'chat', { url });
    root!.render(drawer('session-b'));
  });
  expect(m.tabs.getState().tabs['session-preview:session-b']?.metadata?.originalUrl).toBe(url);
  expect(m.tabs.getState().tabs['session-preview:session-a']).toBe(previous);
  expect([...document.querySelectorAll('input')].map(input => input.value)).toContain(url);
});
