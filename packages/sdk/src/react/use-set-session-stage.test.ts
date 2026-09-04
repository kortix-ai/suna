import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-triggers.test.ts` — `useMutation` mocked to
// identity so the hook is a plain function and its wiring is assertable.
let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

const calls: { url: string; method: string; body: unknown }[] = [];
globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
  calls.push({
    url: String(url),
    method: opts.method ?? 'GET',
    body: opts.body ? JSON.parse(opts.body) : undefined,
  });
  return new Response(JSON.stringify({ session_id: 'S1', stage: { value: 'ready' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

const { configureKortix } = await import('../core/http/config');
configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const { useSetSessionStage } = await import('./use-set-session-stage');
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
  calls.length = 0;
});

describe('useSetSessionStage', () => {
  test('mutationFn PUTs the stage for the given session', async () => {
    const m = useSetSessionStage('proj-1') as any;
    const result = await m.mutationFn({ sessionId: 'S1', stage: 'ready', needs_approval: true });
    expect(calls[0]).toEqual({
      url: 'http://test.local/projects/proj-1/sessions/S1/stage',
      method: 'PUT',
      body: { stage: 'ready', needs_approval: true },
    });
    expect(result.stage).toEqual({ value: 'ready' });
  });

  test('success invalidates the whole sessions family (every list scope)', () => {
    const m = useSetSessionStage('proj-1') as any;
    m.onSuccess();
    expect(invalidated).toEqual([[...qk.project.sessionsScope('proj-1')]]);
  });
});
