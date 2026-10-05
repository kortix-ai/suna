import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import {
  useCaptureAsk,
  useCaptureEpisode,
  useCaptureEpisodes,
  useCaptureExport,
  useCaptureOverview,
  useCaptureWorkflow,
  useCaptureWorkflows,
  useCreateCaptureExport,
  useDraftCaptureSkill,
  useExportCaptureSkill,
  useReviewCaptureWorkflow,
} from './use-capture-intelligence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const A = 'http://test.local/accounts/a1/capture';

function harness(answer: (method: string, path: string) => Response) {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    calls.push(`${method} ${String(url)}`);
    return answer(method, String(url).replace(A, '').split('?')[0]!);
  }) as unknown as typeof fetch;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const mount = async (Probe: () => null) => {
    await act(async () => { create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
    await settle();
  };
  return { calls, mount, settle };
}

test('reads: overview, workflows, one workflow, episodes and one episode; null ids read nothing', async () => {
  const h = harness((_m, path) =>
    Response.json(
      path === '/overview' ? { automation_hours_per_week: 3 } : path === '/workflows' ? { workflows: [], counts: { all: 0 } } : path === '/episodes' ? { episodes: [], next_before: null } : { id: path },
    ),
  );
  let overview: ReturnType<typeof useCaptureOverview>;
  function Probe() {
    overview = useCaptureOverview('a1');
    useCaptureWorkflows('a1', { status: 'detected' });
    useCaptureWorkflow('a1', 'w1');
    useCaptureEpisodes('a1', { workflowId: 'w1' });
    useCaptureEpisode('a1', 'e1');
    useCaptureWorkflow(null, 'w2');
    useCaptureEpisode('a1', null);
    useCaptureOverview(undefined);
    return null;
  }
  await h.mount(Probe);
  expect(overview!.data?.automation_hours_per_week).toBe(3);
  expect(h.calls.sort()).toEqual(
    [`GET ${A}/overview`, `GET ${A}/workflows?status=detected`, `GET ${A}/workflows/w1`, `GET ${A}/episodes?workflow_id=w1`, `GET ${A}/episodes/e1`].sort(),
  );
});

test('a review refreshes the workflow and the list; a published skill too; drafting reads nothing back', async () => {
  const h = harness((method, path) => Response.json(path.endsWith('/skill-draft') ? { name: 'n', markdown: 'm', inputs: [], checks: [] } : path === '/workflows' ? { workflows: [], counts: {} } : { workflow_id: 'w1' }));
  let review: ReturnType<typeof useReviewCaptureWorkflow>;
  let draft: ReturnType<typeof useDraftCaptureSkill>;
  let publish: ReturnType<typeof useExportCaptureSkill>;
  function Probe() {
    useCaptureWorkflows('a1');
    useCaptureWorkflow('a1', 'w1');
    review = useReviewCaptureWorkflow('a1');
    draft = useDraftCaptureSkill('a1');
    publish = useExportCaptureSkill('a1');
    return null;
  }
  await h.mount(Probe);
  const reads = () => h.calls.filter((c) => c === `GET ${A}/workflows/w1` || c === `GET ${A}/workflows`).length;
  let before = reads();
  await act(async () => { await review!.mutateAsync({ workflowId: 'w1', review: { name: 'x' } }); });
  await h.settle();
  expect(h.calls).toContain(`POST ${A}/workflows/w1/review`);
  expect(reads()).toBeGreaterThanOrEqual(before + 2);
  before = reads();
  await act(async () => { expect((await draft!.mutateAsync({ workflowId: 'w1' })).name).toBe('n'); });
  await h.settle();
  expect(reads()).toBe(before);
  await act(async () => { await publish!.mutateAsync({ workflowId: 'w1', input: { project_id: 'p1', name: 'n', markdown: 'm' } }); });
  await h.settle();
  expect(h.calls).toContain(`POST ${A}/workflows/w1/skill`);
  expect(reads()).toBeGreaterThan(before);
});

test('an export polls while it runs and stops when done', async () => {
  let reads = 0;
  const h = harness((method) => {
    if (method === 'POST') return Response.json({ export_id: 'x1', status: 'queued' }, { status: 202 });
    reads += 1;
    return Response.json({ export_id: 'x1', status: reads >= 2 ? 'done' : 'running', download: reads >= 2 ? { url: 'u', expires_at: 'e' } : null });
  });
  let create_: ReturnType<typeof useCreateCaptureExport>;
  let current: ReturnType<typeof useCaptureExport>;
  let id: string | null = null;
  function Probe() {
    create_ = useCreateCaptureExport('a1');
    current = useCaptureExport('a1', id, { pollMs: 20 });
    return null;
  }
  await h.mount(Probe);
  await act(async () => { id = (await create_!.mutateAsync({ format: 'jsonl' })).export_id; });
  await h.mount(Probe);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  expect(current!.data?.status).toBe('done');
  const after = reads;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(reads).toBe(after);
});

test('useCaptureAsk keeps the turns: the question, streamed text, then the cited answer', async () => {
  const frames = [{ type: 'sources', sources: [] }, { type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }, { type: 'done', answer: 'Hello', citations: [], model: 'm', cost_usd: 0 }];
  const h = harness(() =>
    new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }),
  );
  let chat: ReturnType<typeof useCaptureAsk>;
  function Probe() {
    chat = useCaptureAsk('a1');
    return null;
  }
  await h.mount(Probe);
  await act(async () => { await chat!.ask('Say hello'); });
  expect(chat!.turns.map((t) => [t.question, t.answer, t.status])).toEqual([['Say hello', 'Hello', 'done']]);
  expect(h.calls).toEqual([`POST ${A}/ask`]);
});

test('useCaptureAsk follows the agent: each tool it calls, and the sources as they grow', async () => {
  const workflow = { n: 1, kind: 'workflow' as const, workflow_id: 'w1', label: 'Refund', detail: 'd' };
  const frames = [
    { type: 'sources', sources: [] },
    { type: 'tool', name: 'list_workflows', args: { sort: 'runs' } },
    { type: 'sources', sources: [workflow] },
    { type: 'delta', text: 'Refund [1].' },
    { type: 'done', answer: 'Refund [1].', citations: [workflow], model: 'm', cost_usd: 0 },
  ];
  const h = harness(() =>
    new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }),
  );
  let chat: ReturnType<typeof useCaptureAsk>;
  function Probe() {
    chat = useCaptureAsk('a1');
    return null;
  }
  await h.mount(Probe);
  await act(async () => { await chat!.ask('Which workflow runs most?'); });
  const turn = chat!.turns[0]!;
  expect(turn.tools).toEqual([{ name: 'list_workflows', args: { sort: 'runs' } }]);
  expect(turn.sources).toEqual([workflow]);
  expect(turn.citations).toEqual([workflow]);
});
