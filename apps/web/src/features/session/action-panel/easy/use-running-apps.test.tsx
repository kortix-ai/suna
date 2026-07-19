import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// `useRunningApps` reads the active server URL and health off two other
// hooks (`useServerStore`/`useServerHealth`) before it ever calls
// `listListeningPorts` — mocked here at the module boundary (file-global in
// Bun, same convention `mode-gate.test.tsx` uses for a store module) so the
// hook's own `enabled` gate always passes, and the polling call itself hits
// a controllable stand-in rather than a real sandbox daemon.
let ports: Array<{ port: number }> = [];
mock.module('@/stores/server-store', () => ({
  useServerStore: (selector: (s: { getActiveServerUrl: () => string }) => unknown) =>
    selector({ getActiveServerUrl: () => 'http://localhost:8000' }),
}));
mock.module('@/features/files/hooks/use-server-health', () => ({
  useServerHealth: () => ({ data: { healthy: true, version: '1' } }),
}));
mock.module('@/features/files/api/runtime-files', () => ({
  listListeningPorts: () => Promise.resolve(ports),
}));

const { useRunningApps } = await import('./use-running-apps');

function Probe({ isRunning, onResult }: { isRunning: boolean; onResult: (v: unknown) => void }) {
  onResult(useRunningApps(isRunning));
  return null;
}

function withQueryClient(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

describe('useRunningApps', () => {
  test('maps live listening ports to app OutputItems', async () => {
    ports = [{ port: 3000 }, { port: 5173 }];
    let result: unknown;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        withQueryClient(<Probe isRunning={false} onResult={(v) => (result = v)} />),
      );
    });
    // Flush the resolved query + the effect that re-renders with its data.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result).toEqual([
      { callID: 'port:3000', name: 'localhost:3000', kind: 'app', url: 'http://localhost:3000' },
      { callID: 'port:5173', name: 'localhost:5173', kind: 'app', url: 'http://localhost:5173' },
    ]);
    renderer!.unmount();
  });

  test('no listening ports yields an empty list (regression)', async () => {
    ports = [];
    let result: unknown;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        withQueryClient(<Probe isRunning={false} onResult={(v) => (result = v)} />),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result).toEqual([]);
    renderer!.unmount();
  });
});
