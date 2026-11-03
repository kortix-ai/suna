/**
 * The Discord REST client's rate limits, against a local fake: every customer
 * shares one bot token, so a spent bucket or a global limit holds the next
 * call instead of earning another 429.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { config } from '../../config';
import { DiscordApiError, discordCall, resetDiscordRateLimitsForTest } from './api';

/** The fake's answer to the next call of a path; afterwards 200. */
const scripted = new Map<string, { status: number; headers?: Record<string, string>; body: unknown }>();
const hits: Array<{ path: string; at: number }> = [];
const fake = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    hits.push({ path, at: Date.now() });
    const next = scripted.get(path);
    scripted.delete(path);
    if (next) return Response.json(next.body, { status: next.status, headers: next.headers });
    return Response.json({ ok: true });
  },
});

beforeAll(() => {
  Object.assign(config as Record<string, unknown>, { DISCORD_API_URL: fake.url.origin, DISCORD_BOT_TOKEN: 'synthetic-token' });
});
beforeEach(() => {
  resetDiscordRateLimitsForTest();
  scripted.clear();
  hits.length = 0;
});
afterAll(() => fake.stop(true));

test("a spent bucket holds the channel's next call until its reset; another channel is not held", async () => {
  scripted.set('/channels/730000000000000001/messages', {
    status: 200,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.3' },
    body: { id: '1' },
  });
  const route = 'POST /channels/{id}/messages';
  await discordCall(route, '/channels/730000000000000001/messages', { method: 'POST', body: {} });
  const started = Date.now();
  await discordCall(route, '/channels/730000000000000002/messages', { method: 'POST', body: {} });
  expect(Date.now() - started).toBeLessThan(200);
  await discordCall(route, '/channels/730000000000000001/messages', { method: 'POST', body: {} });
  const [first, , third] = hits;
  expect(third!.at - first!.at).toBeGreaterThanOrEqual(250);
});

test("a global limit longer than 5 s fails the bot's next calls without asking Discord; an interaction webhook is not held", async () => {
  scripted.set('/channels/730000000000000001/messages', { status: 429, body: { message: 'You are being rate limited.', retry_after: 30, global: true } });
  await expect(discordCall('POST /channels/{id}/messages', '/channels/730000000000000001/messages', { method: 'POST', body: {} })).rejects.toBeInstanceOf(
    DiscordApiError,
  );
  expect(hits).toHaveLength(1);
  const held = await discordCall('GET /channels/{id}', '/channels/730000000000000009').catch((error: DiscordApiError) => error);
  expect(held).toBeInstanceOf(DiscordApiError);
  expect((held as DiscordApiError).status).toBe(429);
  expect(hits).toHaveLength(1);
  await discordCall('PATCH /webhooks/{app}/{token}/messages/@original', '/webhooks/710000000000000001/token/messages/@original', {
    method: 'PATCH',
    auth: false,
    body: {},
  });
  expect(hits).toHaveLength(2);
});

test('a short 429 waits for its retry_after once, then succeeds', async () => {
  scripted.set('/webhooks/710000000000000001/token', { status: 429, body: { message: 'slow down', retry_after: 0.2 } });
  const started = Date.now();
  await discordCall('POST /webhooks/{app}/{token}', '/webhooks/710000000000000001/token', { method: 'POST', auth: false, body: {} });
  expect(hits).toHaveLength(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(180);
});
