import { describe, expect, test } from 'bun:test';
import { KortixExecutionEnv } from './kortix-env.ts';
import { ResponseError } from './rpc-transport.ts';
import type { RpcTransport } from './rpc-transport.ts';

/** The daemon's wire body shapes, as rpcOnce consumes them. */
const okBody = (value: unknown) => ({ ok: true, value });
const errBody = (code: string, message: string, path?: string) => ({
  ok: false,
  error: { code, message, path },
});

/**
 * A transport scripted one step per call: a rejected step is a transport
 * failure, a resolved step is the daemon's answer. It counts its calls and
 * repeats its last step, so an over-eager retry shows up in `calls`.
 */
class ScriptedTransport implements RpcTransport {
  readonly kind = 'scripted';
  calls = 0;
  constructor(private readonly steps: Array<(op: string) => Promise<unknown>>) {}
  call(op: string) {
    return this.steps[Math.min(this.calls++, this.steps.length - 1)](op);
  }
  async close() {}
}

const env = (transport: RpcTransport, timeoutMs = 5000) =>
  new KortixExecutionEnv({ baseUrl: 'http://scripted.invalid', cwd: '/', transport, timeoutMs });

describe('KortixExecutionEnv.rpc retry policy', () => {
  test('a transport failure is retried once and then succeeds', async () => {
    const transport = new ScriptedTransport([
      () => Promise.reject(new Error('socket hang up')),
      () => Promise.resolve(okBody('done')),
    ]);
    const r = await env(transport).writeFile('/tmp/plan.md', 'hi');
    expect(r.ok).toBe(true);
    expect(transport.calls).toBe(2);
  });

  test('a transport failure retries exactly once, then the error returns in the FileError shape', async () => {
    const transport = new ScriptedTransport([
      () => Promise.reject(new Error('socket hang up')),
      () => Promise.reject(new Error('ECONNRESET while reading')),
    ]);
    const r = await env(transport).writeFile('/tmp/plan.md', 'hi');
    expect(r.ok).toBe(false);
    expect(transport.calls).toBe(2);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.name).toBe('FileError');
      expect(r.error.message).toBe('ECONNRESET while reading');
    }
  });

  test('a daemon err Result never retries, whatever its message says', async () => {
    for (const message of [
      'socket hang up',
      'connection closed unexpectedly',
      'EPIPE writing to the daemon',
      'ECONNRESET while reading',
    ]) {
      const transport = new ScriptedTransport([() => Promise.resolve(errBody('EIO', message))]);
      const r = await env(transport).writeFile('/tmp/plan.md', 'hi');
      expect(r.ok).toBe(false);
      // The daemon answered; the operation may already have applied. Replaying
      // writeFile could write twice.
      expect(transport.calls).toBe(1);
    }
  });

  test('a daemon err Result keeps the daemon error shape', async () => {
    const transport = new ScriptedTransport([
      () => Promise.resolve(errBody('EACCES', 'permission denied', '/tmp/plan.md')),
    ]);
    const r = await env(transport).readTextFile('/tmp/plan.md');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.name).toBe('FileError');
      expect(r.error.code).toBe('EACCES');
      expect(r.error.message).toBe('permission denied');
      expect(r.error.path).toBe('/tmp/plan.md');
    }
  });

  test('the rpc timeout is not retried — the call may still land', async () => {
    const transport = new ScriptedTransport([() => new Promise(() => {})]);
    const r = await env(transport, 20).writeFile('/tmp/plan.md', 'hi');
    expect(r.ok).toBe(false);
    expect(transport.calls).toBe(1);
    if (!r.ok) expect(r.error.message).toBe('rpc timeout');
  });

  test('a response-received failure is not retried — the request was delivered', async () => {
    const transport = new ScriptedTransport([() => Promise.reject(new ResponseError('HTTP 502'))]);
    const r = await env(transport).writeFile('/tmp/plan.md', 'hi');
    expect(r.ok).toBe(false);
    expect(transport.calls).toBe(1);
    if (!r.ok) {
      expect(r.error.name).toBe('FileError');
      expect(r.error.message).toBe('HTTP 502');
    }
  });

  test('a successful call is made exactly once', async () => {
    const transport = new ScriptedTransport([() => Promise.resolve(okBody('content'))]);
    const r = await env(transport).readTextFile('/tmp/plan.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('content');
    expect(transport.calls).toBe(1);
  });
});
