import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  askCapture,
  createCaptureExport,
  draftCaptureSkill,
  exportCaptureSkill,
  getCaptureEpisode,
  getCaptureExport,
  getCaptureOverview,
  getCaptureWorkflow,
  listCaptureEpisodes,
  listCaptureExports,
  listCaptureWorkflows,
  reviewCaptureWorkflow,
  runCaptureIntelligence,
  type CaptureAskEvent,
} from './capture-intelligence';

let calls: { url: string; method: string; body: unknown; accept: string | null }[] = [];
let next: () => Response = () => Response.json({});

beforeEach(() => {
  calls = [];
  next = () => Response.json({});
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
      accept: new Headers(opts.headers).get('accept'),
    });
    return next();
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
const A = 'http://test.local/accounts/a1/capture';

test('overview: a window of the account', async () => {
  next = () => Response.json({ automation_hours_per_week: 41.3, top_opportunities: [], trend: [] });
  expect((await getCaptureOverview('a1', { from: '2026-09-05T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' })).automation_hours_per_week).toBe(41.3);
  expect(last().url).toBe(`${A}/overview?from=2026-09-05T00%3A00%3A00.000Z&to=2026-10-05T00%3A00%3A00.000Z`);
  await getCaptureOverview('a1');
  expect(last().url).toBe(`${A}/overview`);
});

test('workflows: list with filters and counts, one with its procedure, review, skill draft and publish', async () => {
  next = () => Response.json({ workflows: [{ workflow_id: 'w1', status: 'detected' }], counts: { all: 1, detected: 1, reviewed: 0, exported: 0 } });
  const list = await listCaptureWorkflows('a1', { status: 'detected', q: 'refund', app: 'ERP', userId: 'u2', sort: 'runs', limit: 20, offset: 40 });
  expect(list.counts.detected).toBe(1);
  expect(last().url).toBe(`${A}/workflows?status=detected&q=refund&app=ERP&user_id=u2&sort=runs&limit=20&offset=40`);
  await getCaptureWorkflow('a1', 'w1');
  expect(last()).toMatchObject({ method: 'GET', url: `${A}/workflows/w1` });
  await reviewCaptureWorkflow('a1', 'w1', { name: 'Refund a claim', goal: 'Refund damaged orders' });
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/workflows/w1/review`, body: { name: 'Refund a claim', goal: 'Refund damaged orders' } });
  next = () => Response.json({ name: 'refund-a-claim', markdown: '---', inputs: ['order_id'], workflow_updated_at: '2026-10-05T17:50:47.000Z', checks: [] });
  const draft = await draftCaptureSkill('a1', 'w1');
  expect(draft.name).toBe('refund-a-claim');
  // The workflow version the draft read: a host re-drafts when the workflow's updated_at moves past it.
  const version: string = draft.workflow_updated_at;
  expect(version).toBe('2026-10-05T17:50:47.000Z');
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/workflows/w1/skill-draft`, body: {} });
  await exportCaptureSkill('a1', 'w1', { project_id: 'p1', name: 'refund-a-claim', markdown: '# x' });
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/workflows/w1/skill`, body: { project_id: 'p1', name: 'refund-a-claim', markdown: '# x' } });
});

test('run: an admin queues the pipelines now (every untraced range + mining), or mining alone', async () => {
  next = () => Response.json({ episodes_queued: 3, mining_queued: true }, { status: 202 });
  expect(await runCaptureIntelligence('a1')).toEqual({ episodes_queued: 3, mining_queued: true });
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/intelligence/run`, body: {} });
  await runCaptureIntelligence('a1', { mining_only: true });
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/intelligence/run`, body: { mining_only: true } });
});

test('episodes: yours, a member’s or the account’s, by workflow and window, paged by cursor; one with its steps', async () => {
  next = () => Response.json({ episodes: [], next_before: null });
  await listCaptureEpisodes('a1');
  expect(last().url).toBe(`${A}/episodes`);
  await listCaptureEpisodes('a1', { scope: 'account', workflowId: 'w1', deviceId: 'd1', from: 'f', to: 't', before: 'b', limit: 10, userId: 'u2' });
  expect(last().url).toBe(`${A}/episodes?user_id=u2&scope=account&device_id=d1&workflow_id=w1&from=f&to=t&before=b&limit=10`);
  next = () => Response.json({ episode_id: 'e1', steps: [{ index: 0, verb: 'Open' }] });
  expect((await getCaptureEpisode('a1', 'e1')).steps[0]?.verb).toBe('Open');
  expect(last().url).toBe(`${A}/episodes/e1`);
});

test('exports: start one, list, read one with its download', async () => {
  next = () => Response.json({ export_id: 'x1', status: 'queued' }, { status: 202 });
  expect((await createCaptureExport('a1', { format: 'jsonl', include: ['episodes', 'workflows'] })).status).toBe('queued');
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/exports`, body: { format: 'jsonl', include: ['episodes', 'workflows'] } });
  next = () => Response.json({ exports: [] });
  await listCaptureExports('a1');
  expect(last().url).toBe(`${A}/exports`);
  next = () => Response.json({ export_id: 'x1', status: 'done', download: { url: 'https://s3/x', expires_at: 'e' } });
  expect((await getCaptureExport('a1', 'x1')).download?.url).toBe('https://s3/x');
});

const sse = (frames: unknown[]) =>
  new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`)); c.close(); } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

test('ask streams sources, deltas and the cited answer; an error frame throws ApiError with its code', async () => {
  const source = { n: 1, kind: 'workflow', workflow_id: 'w1', label: 'Refund', detail: '' };
  next = () => sse([{ type: 'sources', sources: [source] }, { type: 'delta', text: 'Refund ' }, { type: 'delta', text: 'is top [1].' }, { type: 'done', answer: 'Refund is top [1].', citations: [source], model: 'm', cost_usd: 0.001 }]);
  const events: CaptureAskEvent[] = [];
  const done = await askCapture('a1', { question: 'Top workflow?', scope: { from: 'f' } }, (e) => events.push(e));
  expect(done.answer).toBe('Refund is top [1].');
  expect(done.citations[0]).toMatchObject({ kind: 'workflow', workflow_id: 'w1' });
  expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'delta', 'done']);
  expect(last()).toMatchObject({ method: 'POST', url: `${A}/ask`, body: { question: 'Top workflow?', scope: { from: 'f' } }, accept: 'text/event-stream' });

  next = () => sse([{ type: 'error', code: 'capture_budget_exceeded', error: 'Budget spent' }]);
  const failed = await askCapture('a1', { question: 'x' }, () => {}).catch((e) => e);
  expect(failed).toBeInstanceOf(ApiError);
  expect((failed as ApiError).code).toBe('capture_budget_exceeded');

  next = () => Response.json({ error: 'Capture is off for this account', code: 'capture_disabled' }, { status: 403 });
  const refused = await askCapture('a1', { question: 'x' }, () => {}).catch((e) => e);
  expect([(refused as ApiError).status, (refused as ApiError).code]).toEqual([403, 'capture_disabled']);
});

test('the facade binds every Intelligence call to the account', async () => {
  const capture = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' }).capture.account('a1');
  next = () => Response.json({});
  await capture.overview();
  expect(last().url).toBe(`${A}/overview`);
  await capture.workflows.list({ sort: 'newest' });
  expect(last().url).toBe(`${A}/workflows?sort=newest`);
  await capture.workflows.get('w1');
  await capture.workflows.review('w1', { name: 'n' });
  await capture.workflows.draftSkill('w1', { name: 'n' });
  expect(last()).toMatchObject({ url: `${A}/workflows/w1/skill-draft`, body: { name: 'n' } });
  await capture.workflows.exportSkill('w1', { project_id: 'p1', name: 'n', markdown: 'm' });
  expect(last().url).toBe(`${A}/workflows/w1/skill`);
  await capture.episodes.list({ workflowId: 'w1' });
  expect(last().url).toBe(`${A}/episodes?workflow_id=w1`);
  await capture.episodes.get('e1');
  await capture.exports.create({ format: 'jsonl' });
  await capture.exports.get('x1');
  expect(last().url).toBe(`${A}/exports/x1`);
  next = () => sse([{ type: 'done', answer: 'a', citations: [], model: 'm', cost_usd: 0 }]);
  expect((await capture.ask({ question: 'q' })).answer).toBe('a');
});
