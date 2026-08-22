import { describe, expect, test } from 'bun:test';

// `config` reads required env vars at module-load time — set them before the
// dynamic import so this file runs standalone (same pattern as server.test.ts).
process.env.KORTIX_API_URL = process.env.KORTIX_API_URL ?? 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? 'test-internal-token';

const { config } = await import('./config');

describe('shipped retry defaults', () => {
  // OpenCode 1.18.17 owns transport retry: RETRY_MAX_RETRIES = 5, 2s→30s
  // exponential backoff with 25% jitter, and it honours `Retry-After`. This
  // layer stacking 3 more attempts at 300ms→8s underneath meant a rate-limited
  // or 5xx upstream saw up to 15 replays of the full prompt, the first three
  // with almost no backoff at all.
  test('GATEWAY_RETRY_MAX_ATTEMPTS defaults to ONE in-request attempt', () => {
    expect(process.env.GATEWAY_RETRY_MAX_ATTEMPTS).toBeUndefined();
    expect(config.retry.maxAttempts).toBe(1);
  });

  test('GATEWAY_RETRY_MAX_ATTEMPTS is still an operator override', async () => {
    // A second in-process import would hit the module cache, so load the real
    // module in a fresh Bun process with the env var set.
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        'const { config } = await import("./src/config.ts"); console.log(config.retry.maxAttempts);',
      ],
      {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          KORTIX_API_URL: 'https://api.test.invalid',
          GATEWAY_INTERNAL_TOKEN: 'test-internal-token',
          GATEWAY_RETRY_MAX_ATTEMPTS: '4',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe('4');
  });

  test('the other retry knobs are unchanged', () => {
    expect(config.retry.baseDelayMs).toBe(300);
    expect(config.retry.maxDelayMs).toBe(8_000);
    expect(config.retry.timeoutMs).toBe(90 * 60_000);
  });
});
