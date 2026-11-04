import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  approvePeerMessage,
  createSessionTask,
  deleteSessionTask,
  denyPeerMessage,
  getSessionReachableAgents,
  listPeerMessages,
  listSessionTasks,
  sendPeerMessage,
  setSessionInbound,
  updateSessionTask,
  type PeerMessage,
  type SessionTask,
} from './multi-agent';
import { listProjectSessionsPage } from './sessions';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextBody: unknown = {};
let nextStatus = 200;

beforeEach(() => {
  calls = [];
  nextBody = {};
  nextStatus = 200;
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextBody), { status: nextStatus, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
const SESSION = 'http://test.local/projects/p1/sessions/s1';

const MESSAGE: PeerMessage = {
  id: 'm_7Kq2',
  project_id: 'p1',
  from_session_id: 's2',
  from_handle: 'reviewer',
  to_session_id: 's1',
  to_handle: 'lead',
  type: 'message',
  message: 'The schema migration finished.',
  summary: 'Migration finished',
  status: 'held',
  notify_when_idle: false,
  created_at: '2026-10-30T12:00:00.000Z',
  decided_at: null,
};

const TASK: SessionTask = {
  seq: 3,
  lead_session_id: 's1',
  subject: 'Review the auth module',
  description: '',
  status: 'pending',
  owner_handle: null,
  owner_session_id: null,
  blocked_by: [1],
  blocked: true,
  created_by_session_id: 's1',
  created_at: '2026-10-30T12:00:00.000Z',
  updated_at: '2026-10-30T12:00:00.000Z',
};

test('getSessionReachableAgents reads the reachable route, scope `mine` by default', async () => {
  nextBody = { self: { handle: 'lead' }, agents: [] };
  const answer = await getSessionReachableAgents('p1', 's1');
  expect(answer).toEqual(nextBody as never);
  expect(last()).toMatchObject({ method: 'GET', url: `${SESSION}/reachable` });
  await getSessionReachableAgents('p1', 's1', { scope: 'project' });
  expect(last().url).toBe(`${SESSION}/reachable?scope=project`);
});

test('sendPeerMessage posts the body as the sender session and returns the result', async () => {
  nextBody = { status: 'delivered', message: MESSAGE, to: null, note: 'Sent to reviewer.' };
  const result = await sendPeerMessage('p1', 's1', { to: 'reviewer', message: 'hi', summary: 'Hi' });
  expect(result.status).toBe('delivered');
  expect(last()).toMatchObject({ method: 'POST', url: `${SESSION}/peer-messages`, body: { to: 'reviewer', message: 'hi', summary: 'Hi' } });
});

test('sendPeerMessage rejects a 409 ambiguous recipient with the API error', async () => {
  nextStatus = 409;
  nextBody = { error: true, code: 'ambiguous_recipient', message: 'reviewer names 2 sessions', candidates: [] };
  await expect(sendPeerMessage('p1', 's1', { to: 'reviewer', message: 'hi' })).rejects.toBeDefined();
});

test('listPeerMessages reads one direction, or both', async () => {
  nextBody = { messages: [MESSAGE] };
  expect((await listPeerMessages('p1', 's1', { direction: 'in' })).messages).toEqual([MESSAGE]);
  expect(last().url).toBe(`${SESSION}/peer-messages?direction=in`);
  await listPeerMessages('p1', 's1');
  expect(last().url).toBe(`${SESSION}/peer-messages`);
});

test('approvePeerMessage and denyPeerMessage decide a held message as the receiver', async () => {
  nextBody = { ...MESSAGE, status: 'delivered' };
  expect((await approvePeerMessage('p1', 's1', 'm_7Kq2')).status).toBe('delivered');
  expect(last()).toMatchObject({ method: 'POST', url: `${SESSION}/peer-messages/m_7Kq2/approve` });
  nextBody = { ...MESSAGE, status: 'denied' };
  expect((await denyPeerMessage('p1', 's1', 'm_7Kq2')).status).toBe('denied');
  expect(last()).toMatchObject({ method: 'POST', url: `${SESSION}/peer-messages/m_7Kq2/deny` });
});

test('setSessionInbound puts the inbound setting', async () => {
  nextBody = { inbound: 'hold' };
  expect(await setSessionInbound('p1', 's1', 'hold')).toEqual({ inbound: 'hold' });
  expect(last()).toMatchObject({ method: 'PUT', url: `${SESSION}/inbound`, body: { inbound: 'hold' } });
});

test('the team task routes list, create, update and delete on the lead session', async () => {
  nextBody = { tasks: [TASK] };
  expect((await listSessionTasks('p1', 's1')).tasks).toEqual([TASK]);
  expect(last()).toMatchObject({ method: 'GET', url: `${SESSION}/tasks` });

  nextBody = TASK;
  expect(await createSessionTask('p1', 's1', { subject: 'Review the auth module', blocked_by: [1] })).toEqual(TASK);
  expect(last()).toMatchObject({ method: 'POST', url: `${SESSION}/tasks`, body: { subject: 'Review the auth module', blocked_by: [1] } });

  nextBody = { ...TASK, status: 'in_progress' };
  expect((await updateSessionTask('p1', 's1', 3, { status: 'in_progress' })).status).toBe('in_progress');
  expect(last()).toMatchObject({ method: 'PATCH', url: `${SESSION}/tasks/3`, body: { status: 'in_progress' } });

  nextBody = { deleted: true };
  expect(await deleteSessionTask('p1', 's1', 3)).toEqual({ deleted: true });
  expect(last()).toMatchObject({ method: 'DELETE', url: `${SESSION}/tasks/3` });
});

test('updateSessionTask rejects a 409 task_taken', async () => {
  nextStatus = 409;
  nextBody = { error: true, code: 'task_taken', message: 'Task #3 is taken.' };
  await expect(updateSessionTask('p1', 's1', 3, { claim: true })).rejects.toBeDefined();
});

test('listProjectSessionsPage sends teamLead as team_lead', async () => {
  nextBody = [];
  await listProjectSessionsPage('p1', { teamLead: 's1' });
  expect(last().url).toBe('http://test.local/projects/p1/sessions?team_lead=s1');
});

test('a session handle binds the multi-agent routes to its own ids', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const session = kortix.session('p1', 's1');

  nextBody = { self: {}, agents: [] };
  await session.reachable({ scope: 'project' });
  expect(last().url).toBe(`${SESSION}/reachable?scope=project`);

  nextBody = { status: 'delivered', message: MESSAGE, to: null, note: '' };
  await session.peerMessages.send({ to: 'reviewer', message: 'hi' });
  expect(last()).toMatchObject({ method: 'POST', url: `${SESSION}/peer-messages` });
  nextBody = { messages: [] };
  await session.peerMessages.list({ direction: 'out' });
  expect(last().url).toBe(`${SESSION}/peer-messages?direction=out`);
  nextBody = MESSAGE;
  await session.peerMessages.approve('m1');
  expect(last().url).toBe(`${SESSION}/peer-messages/m1/approve`);
  await session.peerMessages.deny('m1');
  expect(last().url).toBe(`${SESSION}/peer-messages/m1/deny`);

  nextBody = { inbound: 'refuse' };
  await session.setInbound('refuse');
  expect(last()).toMatchObject({ method: 'PUT', url: `${SESSION}/inbound`, body: { inbound: 'refuse' } });

  nextBody = { tasks: [] };
  await session.tasks.list();
  expect(last().url).toBe(`${SESSION}/tasks`);
  nextBody = TASK;
  await session.tasks.create({ subject: 'x' });
  expect(last()).toMatchObject({ method: 'POST', url: `${SESSION}/tasks` });
  await session.tasks.update(3, { owner: null });
  expect(last()).toMatchObject({ method: 'PATCH', url: `${SESSION}/tasks/3`, body: { owner: null } });
  nextBody = { deleted: true };
  await session.tasks.remove(3);
  expect(last()).toMatchObject({ method: 'DELETE', url: `${SESSION}/tasks/3` });
});
