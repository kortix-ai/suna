import { afterEach, expect, jest, test } from 'bun:test';
import { Hono } from 'hono';
import { requestDeadline, requestDeadlineMs } from './request-deadline';

const path = '/v1/projects/00000000-0000-4000-a000-000000000001/sessions';
afterEach(() => jest.useRealTimers());

test('session creation returns its receipt and initial prompt after the general deadline', async () => {
  jest.useFakeTimers();
  const app = new Hono();
  app.use('*', requestDeadline);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  app.post(path, async (c) => {
    const body = await c.req.json<{ initial_prompt: string }>();
    await held;
    return c.json({ session_id: 'synthetic-session', initial_prompt: body.initial_prompt }, 201);
  });
  let answered = false;
  const pending = Promise.resolve(app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initial_prompt: 'Reply with pong' }),
  })).then((response) => { answered = true; return response; });
  await Promise.resolve();
  jest.advanceTimersByTime(30_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const answeredBeforeCommit = answered;
  release();
  const response = await pending;
  expect(answeredBeforeCommit).toBe(false);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ session_id: 'synthetic-session', initial_prompt: 'Reply with pong' });
});

test('only the exact session create route bypasses the general deadline', async () => {
  const app = new Hono();
  app.all('*', (c) => c.json({ deadline: requestDeadlineMs(c) }));
  for (const [route, method] of [
    [path, 'GET'], [path, 'DELETE'], [`${path}/session-1`, 'POST'],
    [`${path}/session-1/prompts`, 'POST'], ['/v1/accounts/example/sessions', 'POST'],
  ]) {
    const response = await app.request(route, { method });
    expect((await response.json()).deadline).toBe(25_000);
  }
  const response = await app.request(path, { method: 'POST' });
  expect(await response.json()).toEqual({ deadline: null });
});
