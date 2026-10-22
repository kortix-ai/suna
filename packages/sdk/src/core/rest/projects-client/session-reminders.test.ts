import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import type { CreateSessionReminderInput, SessionReminder } from './session-reminders';
import {
  createSessionReminder,
  listProjectReminders,
  deleteSessionReminder,
  deleteSessionReminders,
  listSessionReminders,
  updateSessionReminder,
  updateSessionReminders,
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

describe('reminder batches', () => {
  const refs = Array.from({ length: 10 }, (_, i) => ({ sessionId: `s${i % 3}`, reminderId: `reminder.${i}` }));

  /** A fetch that holds every request until released, counting how many are in flight. */
  function heldFetch(fail: (url: string) => boolean = () => false) {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      seen.push(`${opts.method} ${String(url)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const failed = fail(String(url));
      return new Response(JSON.stringify(failed ? { error: 'gone' } : { ok: true }), {
        status: failed ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { peak: () => peak, seen };
  }

  test('updateSessionReminders PATCHes each reminder, at most 4 at a time', async () => {
    const net = heldFetch();
    const result = await updateSessionReminders('p1', refs, { enabled: false });
    expect(net.seen).toHaveLength(10);
    expect(net.seen.every((call) => call.startsWith('PATCH http://test.local/projects/p1/sessions/s'))).toBe(true);
    expect(net.seen).toContain('PATCH http://test.local/projects/p1/sessions/s1/reminders/reminder.4');
    expect(net.peak()).toBe(4);
    expect(result.done).toEqual(refs);
    expect(result.failed).toEqual([]);
  });

  test('deleteSessionReminders keeps going past a failure and reports it', async () => {
    const net = heldFetch((url) => url.endsWith('/reminder.3'));
    const result = await deleteSessionReminders('p1', refs);
    expect(net.seen).toHaveLength(10);
    expect(net.seen.every((call) => call.startsWith('DELETE '))).toBe(true);
    expect(result.done).toEqual(refs.filter((ref) => ref.reminderId !== 'reminder.3'));
    expect(result.failed.map((f) => f.reminder)).toEqual([refs[3]!]);
    expect(result.failed[0]!.error).toBeInstanceOf(Error);
  });

  test('an empty batch sends nothing', async () => {
    const net = heldFetch();
    expect(await deleteSessionReminders('p1', [])).toEqual({ done: [], failed: [] });
    expect(net.seen).toEqual([]);
  });
});

test('kortix.project(id).reminders batches a selection through the facade', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const reminders = [
    { sessionId: 's1', reminderId: 'reminder.a' },
    { sessionId: 's2', reminderId: 'reminder.b' },
  ];
  nextBody = REMINDER;
  expect(await kortix.project('p1').reminders.updateMany(reminders, { enabled: false })).toEqual({
    done: reminders,
    failed: [],
  });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'PATCH http://test.local/projects/p1/sessions/s1/reminders/reminder.a',
    'PATCH http://test.local/projects/p1/sessions/s2/reminders/reminder.b',
  ]);
  expect(calls[0]!.body).toEqual({ enabled: false });
  calls = [];
  nextBody = { ok: true };
  await kortix.project('p1').reminders.removeMany(reminders);
  expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
});
