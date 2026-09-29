import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import type { CreateSessionReminderInput, SessionReminder } from './session-reminders';
import {
  createSessionReminder,
  listProjectReminders,
  deleteSessionReminder,
  listSessionReminders,
  updateSessionReminder,
} from './session-reminders';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextBody: unknown = {};

beforeEach(() => {
  calls = [];
  nextBody = {};
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

const REMINDER: SessionReminder = {
  id: 'reminder.0123456789ab',
  session_id: 's1',
  name: null,
  prompt: 'Did the email arrive?',
  every: '1h',
  every_seconds: 3600,
  cron: null,
  timezone: 'UTC',
  at: null,
  state: 'active',
  next_fire_at: '2026-09-29T12:00:00.000Z',
  last_fired_at: null,
  last_status: null,
  last_error: null,
  created_by: 'u1',
  created_at: '2026-09-28T12:00:00.000Z',
};

test('listSessionReminders GETs the session reminders', async () => {
  nextBody = { reminders: [REMINDER] };
  const result = await listSessionReminders('p1', 's1');
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/projects/p1/sessions/s1/reminders' });
  expect(result.reminders[0]?.id).toBe('reminder.0123456789ab');
});

test('createSessionReminder POSTs the schedule and prompt', async () => {
  nextBody = REMINDER;
  const input: CreateSessionReminderInput = { prompt: 'Did the email arrive?', in: '24h', every: '1h' };
  const reminder = await createSessionReminder('p1', 's1', input);
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://test.local/projects/p1/sessions/s1/reminders',
    body: { prompt: 'Did the email arrive?', in: '24h', every: '1h' },
  });
  expect(reminder.state).toBe('active');
});

test('updateSessionReminder PATCHes enabled; deleteSessionReminder DELETEs', async () => {
  nextBody = { ...REMINDER, state: 'paused' };
  await updateSessionReminder('p1', 's1', 'reminder.0123456789ab', { enabled: false });
  expect(last()).toMatchObject({
    method: 'PATCH',
    url: 'http://test.local/projects/p1/sessions/s1/reminders/reminder.0123456789ab',
    body: { enabled: false },
  });
  nextBody = { ok: true };
  await deleteSessionReminder('p1', 's1', 'reminder.0123456789ab');
  expect(last()).toMatchObject({
    method: 'DELETE',
    url: 'http://test.local/projects/p1/sessions/s1/reminders/reminder.0123456789ab',
  });
});

test('the session handle binds its ids into reminders.*', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const reminders = kortix.session('p1', 's1').reminders;
  nextBody = { reminders: [] };
  await reminders.list();
  expect(last().url).toBe('http://test.local/projects/p1/sessions/s1/reminders');
  nextBody = REMINDER;
  await reminders.create({ prompt: 'x', every: '30m' });
  expect(last()).toMatchObject({ method: 'POST', body: { prompt: 'x', every: '30m' } });
  await reminders.update('reminder.0123456789ab', { enabled: true });
  expect(last()).toMatchObject({ method: 'PATCH', body: { enabled: true } });
  nextBody = { ok: true };
  await reminders.remove('reminder.0123456789ab');
  expect(last().method).toBe('DELETE');
});

test('listProjectReminders GETs every reminder in the project; the facade binds the project id', async () => {
  nextBody = { reminders: [{ ...REMINDER, session_name: 'Vendor follow-up' }] };
  const result = await listProjectReminders('p1');
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/projects/p1/reminders' });
  expect(result.reminders[0]?.session_name).toBe('Vendor follow-up');
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  await kortix.project('p1').reminders.list();
  expect(last().url).toBe('http://test.local/projects/p1/reminders');
});
