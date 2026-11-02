import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createTokenRateLimit } from './token-rate-limit';

const request = (path: string, headers: Record<string, string>) =>
  new Request(`https://gateway.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{"model":"x","messages":[]}',
  });

afterEach(() => setSystemTime());

describe('per-credential request limit', () => {
  test('refuses the request over the limit with 429 and Retry-After, and the next minute admits it again', async () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    const call = () => limit(request('/v1/chat/completions', { authorization: 'Bearer kortix_sb_a' }));
    expect(call()).toBeNull();
    expect(call()).toBeNull();
    const refused = call();
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('30');
    const body = (await refused!.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');

    setSystemTime(new Date('2026-11-02T12:00:30Z'));
    expect(call()).toBeNull();
  });

  test('counts each credential apart, and x-api-key is a credential', () => {
    const limit = createTokenRateLimit(1);
    expect(limit(request('/v1/chat/completions', { authorization: 'Bearer kortix_sb_a' }))).toBeNull();
    expect(limit(request('/v1/chat/completions', { authorization: 'Bearer kortix_sb_a' }))?.status).toBe(429);
    expect(limit(request('/v1/chat/completions', { authorization: 'Bearer kortix_sb_b' }))).toBeNull();
    expect(limit(request('/v1/messages', { 'x-api-key': 'kortix_gw_c' }))).toBeNull();
    expect(limit(request('/v1/messages', { 'x-api-key': 'kortix_gw_c' }))?.status).toBe(429);
  });

  test('does not count a request without a credential: the pipeline refuses it with 401 and no API call', () => {
    const limit = createTokenRateLimit(1);
    for (let i = 0; i < 5; i++) expect(limit(request('/v1/chat/completions', {}))).toBeNull();
  });

  test('answers Messages and Claude Code requests in the Anthropic envelope', async () => {
    const limit = createTokenRateLimit(1);
    for (const path of ['/v1/messages', '/v1/claude-code/v1/messages']) {
      const headers = { authorization: `Bearer kortix_sb_${path.length}` };
      limit(request(path, headers));
      const refused = limit(request(path, headers));
      expect(refused?.status).toBe(429);
      expect(await refused!.json()).toEqual({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Too many requests for this credential. Retry shortly.' },
      });
    }
  });
});
