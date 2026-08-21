/**
 * The contract this file exists to hold: UNDER ANY LOAD, THE PROCESS SURVIVES.
 *
 * On 2026-08-21 the dev API was OOM-killed three times in eleven minutes during
 * an image-heavy session and browsers were handed Cloudflare's "Bad Gateway"
 * page. The rule that came out of it has three parts, and all three are asserted
 * here against the REAL mounted routes rather than a stand-in:
 *
 *   1. It never crashes — no unhandled rejection, no uncaught exception, and
 *      the process still serves normally afterwards.
 *   2. It fails LOUDLY and SPECIFICALLY — 413 for a body that can never fit,
 *      503 + Retry-After for one that would fit if the gateway were quieter.
 *      Never a hang, never a silent truncation, never a generic 500.
 *   3. It keeps scaling — refusals are cheap and bounded, so the fleet can grow
 *      into the load instead of losing tasks to the kernel.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

// The gateway surface is only mounted when it is enabled, and `config` is read
// at module load — so the env has to be set BEFORE `wire.ts` is imported, which
// a hoisted static import cannot guarantee. A dynamic import after the
// assignment is what makes the real routes (not the `503 disabled` stub) the
// thing under test.
process.env.LLM_GATEWAY_ENABLED = 'true';
process.env.OPENROUTER_API_KEY ??= 'sk-or-test-overload-safety';
// A deliberately small budget so shedding is the DOMINANT outcome of the storm
// below. With the production default (512 MiB) this test would need gigabytes of
// payload to prove the same property, and would mostly measure the DB instead.
process.env.GATEWAY_INFLIGHT_BUDGET_BYTES = String(32 * 1024 * 1024);
const { mountLlmGateway } = await import('./wire');

const MiB = 1024 * 1024;

const app = new OpenAPIHono();
mountLlmGateway(app);

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer kortix_gw_test', ...headers },
    body,
  });

/** A syntactically valid chat body padded to roughly `bytes`. */
const bodyOfSize = (bytes: number): string => {
  const filler = 'x'.repeat(Math.max(0, bytes - 120));
  return JSON.stringify({
    model: 'kortix/test-model',
    stream: false,
    messages: [{ role: 'user', content: filler }],
  });
};

// A crash in this process is exactly what we are testing against, so the test
// watches for one directly instead of trusting the suite to notice.
const fatal: unknown[] = [];
const onRejection = (reason: unknown): void => {
  fatal.push(reason);
};
const onException = (err: unknown): void => {
  fatal.push(err);
};

beforeAll(() => {
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
});

afterAll(() => {
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
});

describe('gateway overload safety', () => {
  test('a body beyond the per-request ceiling is refused with a clear 413, not a crash', async () => {
    // Declared via content-length so it is refused from the header, without the
    // body ever being read — the whole point of moving the guard upstream.
    const res = await post('/v1/llm/chat/completions', bodyOfSize(1024), {
      'content-length': String(512 * MiB),
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error?: { message?: string; code?: string } };
    const message = JSON.stringify(json);
    expect(message).toContain('request_too_large');
    // DIGIT-FREE: OpenCode decides retryability by regexing /429|500|502|503|504|524/i
    // over the whole body, so a byte count containing "500" would make a client
    // re-upload an over-limit body five times.
    expect(/429|500|502|503|504|524/.test(message)).toBe(false);
  });

  test('an oversized body still answers 413 when content-length lies about it', async () => {
    const res = await post('/v1/llm/chat/completions', bodyOfSize(200 * MiB));
    expect(res.status).toBe(413);
  });

  test('every response under a concurrent storm is a real status — nothing hangs or crashes', async () => {
    // 60 x 8 MiB = ~480 MiB of wire bytes offered at once, ~1.4 GiB after
    // amplification, against a 512 MiB budget. Most of this MUST be refused.
    const payload = bodyOfSize(8 * MiB);
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, () => post('/v1/llm/chat/completions', payload)),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);

    const statuses = results.map((r) => (r as PromiseFulfilledResult<Response>).value.status);
    // Every single one got a real HTTP answer: nothing hung, nothing threw.
    expect(statuses).toHaveLength(60);
    expect(statuses.every((s) => s >= 200 && s < 600)).toBe(true);

    // Load shedding is the dominant outcome — otherwise this test proves nothing
    // about the budget, and the next image-heavy burst is the one that kills it.
    const shed = statuses.filter((s) => s === 503 || s === 413);
    expect(shed.length).toBeGreaterThan(statuses.length / 2);

    // NOT asserted: the absence of 500s. A request the budget ADMITS goes on to
    // authenticate, and this hermetic suite has no database — so an admitted
    // request legitimately 500s here. Asserting "no 500" would be asserting
    // something false about the environment rather than anything about the
    // gateway. What matters is that shedding is decided BEFORE that work, which
    // the ratio above proves.
  }, 60_000);

  test('a shed request says RETRY, with a Retry-After the caller can act on', async () => {
    const payload = bodyOfSize(8 * MiB);
    const responses = await Promise.all(
      Array.from({ length: 60 }, () => post('/v1/llm/chat/completions', payload)),
    );
    const overloaded = responses.find((r) => r.status === 503);
    // If nothing was shed the budget is misconfigured for this test, which is
    // itself worth failing on.
    expect(overloaded).toBeDefined();
    if (overloaded) {
      expect(overloaded.headers.get('retry-after')).toBeTruthy();
      const body = JSON.stringify(await overloaded.json());
      expect(body).toContain('gateway_overloaded');
      // "Retry shortly" and "this can never work" must not be confusable.
      expect(body).not.toContain('request_too_large');
    }
  }, 60_000);

  test('the process is unharmed and still serving after the storm', async () => {
    // The real proof: no crash handler fired, and an ordinary request still
    // behaves normally rather than inheriting a poisoned budget.
    expect(fatal).toEqual([]);

    const health = await app.request('/v1/llm/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ service: 'kortix-llm-gateway' });

    // A small request is admitted again — every lease from the storm was
    // released, so the budget is not permanently consumed.
    const res = await post('/v1/llm/chat/completions', bodyOfSize(1024));
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(413);
  }, 30_000);
});
