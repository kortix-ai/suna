import { afterAll, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';

const originalGlobals = ['window', 'document'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
const window = new Window({ url: 'http://localhost/' });
Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
afterAll(() => {
  for (const { key, descriptor } of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});

// ── A host's resolvePreviewUrl ─────────────────────────────────────────────
// The session Browser (AppPreview) frames a sandbox port. A host whose origin
// is not the Kortix backend resolves that URL on its server (UiProvider
// resolvePreviewUrl). AppPreview must frame the host's answer and must never
// put the SDK token into the frame URL.

describe('AppPreview — host resolvePreviewUrl', () => {
  test('frames the URL the host resolves for http://localhost:8090/', async () => {
    const { act, create } = await import('react-test-renderer');
    const { UiProvider } = await import('../../../providers/ui-provider');
    const { AppPreview } = await import('./app-preview');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const asked: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(
          <QueryClientProvider client={client}>
            <UiProvider
              resolvePreviewUrl={async (request) => {
                asked.push(request);
                return 'https://host.example/frame?scoped=1';
              }}
            >
              <AppPreview
                url="http://localhost:8090/"
                name="localhost:8090"
                projectId="p1"
                shareContext={{ projectId: 'p1', sessionId: 's1' }}
                onClose={() => {}}
              />
            </UiProvider>
          </QueryClientProvider>,
        );
      });
      expect(asked).toEqual([
        { projectId: 'p1', sessionId: 's1', port: 8090, path: '/', url: 'http://localhost:8090/' },
      ]);
      expect(root.root.findByType('iframe').props.src).toBe('https://host.example/frame?scoped=1');
    } finally {
      await act(async () => root?.unmount());
      client.clear();
      globalThis.fetch = realFetch;
    }
  });
});
