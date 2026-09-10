import { describe, expect, test } from 'bun:test';
import { KortixExecutionEnv, toExecTimeoutMs, toFileErrorCode } from './kortix-env.ts';
import type { RpcTransport } from './rpc-transport.ts';
import { RpcCancellationError } from './rpc-transport.ts';

function replaceTransport(
  env: KortixExecutionEnv,
  call: RpcTransport['call'],
  close: RpcTransport['close'] = async () => {},
): void {
  (env as unknown as { transport: RpcTransport }).transport = {
    kind: 'test',
    call,
    close,
  };
}

// The daemon's env-rpc is a thin fs proxy and reports the real errno. pi's
// tools compare against pi's OWN codes, so this client has to translate.
// Unmapped, `write` could never create a file: withFileMutationQueue
// canonicalises the target first and rethrows anything that is not
// 'not_found', so every new file died on the pre-flight lstat and the agent
// fell back to bash heredocs (observed 10x in one turn on pi.kortix.com).
describe('toFileErrorCode', () => {
  test('ENOENT becomes not_found — the code the file-mutation queue tolerates', () => {
    expect(toFileErrorCode('ENOENT')).toBe('not_found');
  });

  test('mirrors pi harness/env/nodejs.js, spellings included', () => {
    expect(toFileErrorCode('ABORT_ERR')).toBe('aborted');
    expect(toFileErrorCode('EACCES')).toBe('permission_denied');
    expect(toFileErrorCode('EPERM')).toBe('permission_denied');
    // pi spells these without the article; a tool matching 'not_a_directory'
    // would never fire.
    expect(toFileErrorCode('ENOTDIR')).toBe('not_directory');
    expect(toFileErrorCode('EISDIR')).toBe('is_directory');
    expect(toFileErrorCode('EINVAL')).toBe('invalid');
  });

  test('an unmapped errno is unknown, never passed through as an errno', () => {
    // Handing pi a raw 'EMFILE' just moves the same bug to another code path.
    expect(toFileErrorCode('EMFILE')).toBe('unknown');
    expect(toFileErrorCode('ENOSPC')).toBe('unknown');
  });

  test('a code already in pi vocabulary survives, and nothing missing throws', () => {
    expect(toFileErrorCode('not_supported')).toBe('not_supported');
    expect(toFileErrorCode(undefined)).toBe('unknown');
    expect(toFileErrorCode('')).toBe('unknown');
  });
});

/**
 * pi's `ExecutionEnvironment.exec` takes a timeout in SECONDS
 * (@earendil-works/pi-agent-core harness/types.d.ts:205 — "Timeout in
 * seconds"). The Kortix daemon reads the same field as `timeoutMs` and
 * SIGKILLs the child on it (kortix-sandbox-agent-server routes/env-rpc.ts,
 * `case 'exec'`). Forwarding the number unconverted killed every model-supplied
 * timeout ~1000x early — `bash({ timeout: 600 })` meaning ten minutes died
 * after 600ms with exit 124, and the model was told it had timed out.
 */
describe('toExecTimeoutMs', () => {
  test('converts pi seconds to daemon milliseconds', () => {
    expect(toExecTimeoutMs(600)).toBe(600_000);
    expect(toExecTimeoutMs(1)).toBe(1_000);
    expect(toExecTimeoutMs(0.5)).toBe(500);
  });

  test('leaves an unset timeout unset so the daemon applies its own default', () => {
    expect(toExecTimeoutMs(undefined)).toBeUndefined();
    expect(toExecTimeoutMs(null)).toBeUndefined();
    expect(toExecTimeoutMs('600')).toBeUndefined();
  });

  test('refuses values that would read as "kill immediately"', () => {
    // 0 forwarded as 0 is a SIGKILL before the command starts.
    expect(toExecTimeoutMs(0)).toBeUndefined();
    expect(toExecTimeoutMs(-5)).toBeUndefined();
    expect(toExecTimeoutMs(Number.NaN)).toBeUndefined();
    expect(toExecTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('RPC replay safety', () => {
  test('a mutation that commits before its response drops executes exactly once', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
    });
    let sideEffects = 0;
    replaceTransport(env, async () => {
      sideEffects += 1;
      if (sideEffects === 1) throw new Error('rpc socket closed after commit');
      return { ok: true, value: undefined };
    });

    const result = await env.writeFile('/workspace/result.txt', 'payload');

    expect(sideEffects).toBe(1);
    expect(result.ok).toBe(false);
  });

  test('a read still retries once when the response drops', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
    });
    let attempts = 0;
    replaceTransport(env, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('rpc socket closed');
      return { ok: true, value: 'contents' };
    });

    const result = await env.readTextFile('/workspace/result.txt');

    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: true, value: 'contents' });
  });

  test("an aborted read is not replayed and returns Pi's aborted code", async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
    });
    const controller = new AbortController();
    let attempts = 0;
    replaceTransport(env, async (_op, _args, _cwd, signal) => {
      attempts += 1;
      controller.abort();
      await Promise.resolve();
      throw signal?.reason ?? new Error('aborted');
    });

    const result = await env.readTextFile('/workspace/result.txt', controller.signal);

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('aborted');
  });

  test('exec forwards its AbortSignal and exposes a cancellation settlement barrier', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
    });
    const controller = new AbortController();
    const abortReason = new Error('caller stopped');
    let forwardedSignal: AbortSignal | undefined;
    let release!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      release = resolve;
    });
    replaceTransport(env, async (_op, _args, _cwd, signal) => {
      forwardedSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            release();
            resolve();
          },
          { once: true },
        );
      });
      throw new Error('aborted');
    });

    const run = env.exec('sleep 10', { abortSignal: controller.signal });
    controller.abort(abortReason);
    await env.waitForAbortSettled();

    await cancelled;
    expect(forwardedSignal?.aborted).toBe(true);
    expect(forwardedSignal?.reason).toBe(abortReason);
    const result = await run;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('aborted');
  });

  test('the cancellation settlement barrier rejects when remote cancellation is unconfirmed', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
    });
    const controller = new AbortController();
    replaceTransport(env, async (_op, _args, _cwd, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new RpcCancellationError('cancel endpoint unavailable');
    });
    const run = env.exec('sleep 10', { abortSignal: controller.signal });

    controller.abort();

    await expect(env.waitForAbortSettled()).rejects.toThrow(/cancel endpoint unavailable/);
    const result = await run;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown');
  });

  test('RPC timeout aborts the transport and waits for cancellation settlement', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
      timeoutMs: 0,
    });
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationStarted!: () => void;
    const cancellationStart = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });

    replaceTransport(env, async (_op, _args, _cwd, signal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          cancellationStarted();
          resolve();
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            cancellationStarted();
            resolve();
          },
          { once: true },
        );
      });
      await cancellationReleased;
      throw signal?.reason ?? new Error('aborted');
    });

    const run = env.exec('sleep 600', { timeout: 600 });
    const timeoutAbortedTransport = await Promise.race([
      cancellationStart.then(() => true),
      run.then(() => false),
    ]);
    expect(timeoutAbortedTransport).toBe(true);

    let barrierSettled = false;
    const barrier = env.waitForAbortSettled().then(() => {
      barrierSettled = true;
    });
    await Promise.resolve();
    expect(barrierSettled).toBe(false);

    releaseCancellation();
    await barrier;
    const result = await run;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected timeout failure');
    expect(result.error.code).toBe('unknown');
    expect(result.error.message).toBe('rpc timeout');
  });

  test('a timed-out read is aborted once and is not replayed', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
      timeoutMs: 0,
    });
    let attempts = 0;
    replaceTransport(env, async (_op, _args, _cwd, signal) => {
      attempts += 1;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw signal?.reason ?? new Error('aborted');
    });

    const result = await env.readTextFile('/workspace/result.txt');
    await env.waitForAbortSettled();

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected timeout failure');
    expect(result.error.code).toBe('unknown');
    expect(result.error.message).toBe('rpc timeout');
  });
});

describe('RPC transport lifecycle', () => {
  test('cleanup closes the session transport', async () => {
    const env = new KortixExecutionEnv({
      baseUrl: 'http://unused.invalid',
      cwd: '/workspace',
      transport: 'fetch',
    });
    let closes = 0;
    replaceTransport(
      env,
      async () => ({ ok: true, value: undefined }),
      async () => {
        closes += 1;
      },
    );

    await env.cleanup();

    expect(closes).toBe(1);
  });
});
