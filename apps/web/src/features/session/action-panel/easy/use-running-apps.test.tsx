import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@kortix/sdk';
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
let portsError: unknown = null;
mock.module('@/stores/server-store', () => ({
  useServerStore: (selector: (s: { getActiveServerUrl: () => string }) => unknown) =>
    selector({ getActiveServerUrl: () => 'http://localhost:8000' }),
}));
mock.module('@/features/files/hooks/use-server-health', () => ({
  useServerHealth: () => ({ data: { healthy: true, version: '1' } }),
}));
mock.module('@/features/files/api/runtime-files', () => ({
  listListeningPorts: () => (portsError ? Promise.reject(portsError) : Promise.resolve(ports)),
}));

const { useRunningApps } = await import('./use-running-apps');

function Probe({
  isRunning,
  executeCompletions,
  onResult,
}: {
  isRunning: boolean;
  executeCompletions?: number;
  onResult: (v: unknown) => void;
}) {
  onResult(useRunningApps(isRunning, executeCompletions));
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

  // W1 — a completed 'run'-family tool call (a server the agent just started)
  // should surface the new port fast, not wait out the 5s/30s poll interval.
  // `easy-panel.tsx` computes the rising counter; the hook's own job is just
  // to refetch the instant it sees the counter go up.
  test('an increasing executeCompletions triggers an immediate refetch', async () => {
    ports = [{ port: 3000 }];
    portsError = null;
    let fetchCount = 0;
    mock.module('@/features/files/api/runtime-files', () => ({
      listListeningPorts: () => {
        fetchCount += 1;
        return portsError ? Promise.reject(portsError) : Promise.resolve(ports);
      },
    }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        withQueryClient(
          <Probe isRunning={false} executeCompletions={0} onResult={() => {}} />,
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const afterMount = fetchCount;
    expect(afterMount).toBeGreaterThan(0);

    // Same value again — a re-render alone must not cause an extra fetch.
    await act(async () => {
      renderer!.update(
        withQueryClient(
          <Probe isRunning={false} executeCompletions={0} onResult={() => {}} />,
        ),
      );
    });
    expect(fetchCount).toBe(afterMount);

    // The counter rises (a run just completed) — must refetch right away.
    await act(async () => {
      renderer!.update(
        withQueryClient(
          <Probe isRunning={false} executeCompletions={1} onResult={() => {}} />,
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchCount).toBeGreaterThan(afterMount);
    renderer!.unmount();
  });

  // 404 pin — a sandbox that has no /ports route yet (old image) or one that's
  // gone stale must degrade to "no apps", never crash the panel or spam retries.
  test('a 404 from listListeningPorts pins the hook to [] with no throw and no retry', async () => {
    portsError = new ApiError('not found', { status: 404 });
    let result: unknown = 'unset';
    let threw = false;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          withQueryClient(<Probe isRunning={false} onResult={(v) => (result = v)} />),
        );
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual([]);
    renderer!.unmount();
    portsError = null;
  });
});
