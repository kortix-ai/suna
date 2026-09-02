/**
 * P2.5 — "A live worker with a reaped environment must be a DEFINED state, not
 * a DISCOVERED one — including what the next tool call does when it finds one."
 *
 * Today it is discovered, and the answer is: it fails forever.
 * `LazyKortixEnv.attach()` opens with `if (this.inner) return this.inner`, and
 * nothing anywhere clears `this.inner`. So the client minted on the first tool
 * call is the client used for the worker's entire life, pinned to one
 * provider-edge URL and one external_id.
 *
 * That was survivable while nothing stopped an environment out from under a
 * live worker. It no longer is — this branch added the sweeps that do exactly
 * that:
 *   - idle 24h  -> stop  (orphan-environments.ts, idle-stop)
 *   - worker parked -> stop  (worker-stopped)
 *   - removed box -> external_id cleared and reprovisioned under a NEW id
 *     (environment-liveness.ts)
 * In all three the control plane is behaving correctly and `ensure` would
 * happily hand back a working box. The worker just never asks again.
 *
 * The recovery has to key off the ERROR, not off an exception:
 * `KortixExecutionEnv.rpcOnce` catches everything — "Never throw. A dead
 * environment is a Result, not an exception." (kortix-env.ts:174-175) — so an
 * unreachable box and a legitimate "file not found" arrive in the same shape
 * and must be told apart by inspecting the error.
 */
import { describe, expect, test } from 'bun:test';
import { isEnvironmentUnreachable } from './env-reattach.ts';
import { LazyKortixEnv } from './lazy-env.ts';

describe('telling a dead environment from a failed operation', () => {
  const unreachable = [
    'fetch failed',
    'connect ECONNREFUSED 10.0.0.4:443',
    'rpc timeout',
    'socket closed',
    'The socket connection was closed unexpectedly',
    'ECONNRESET',
    'terminated',
    'Unable to connect. Is the computer able to access the url?',
  ];
  test.each(unreachable)('%s is the environment, not the tool', (message) => {
    expect(isEnvironmentUnreachable({ code: 'unknown', message })).toBe(true);
  });

  /**
   * The false-positive that would matter: re-attaching on an ordinary tool
   * failure turns every missing file into a provider round-trip.
   */
  const toolFailures = [
    { code: 'not-found', message: 'no such file or directory' },
    { code: 'permission', message: 'permission denied' },
    { code: 'exists', message: 'file already exists' },
    { code: 'not-a-directory', message: 'not a directory' },
  ];
  test.each(toolFailures)('$code is the tool, not the environment', (error) => {
    expect(isEnvironmentUnreachable(error)).toBe(false);
  });

  /**
   * The case that makes the code check load-bearing rather than decorative: a
   * real tool failure whose MESSAGE contains a transport word. Paths like
   * `/var/run/docker.sock` and `/tmp/agent.socket` are ordinary things to stat,
   * and "connection" and "closed" show up in plenty of daemon messages. On
   * message alone every one of these would discard a perfectly healthy
   * environment and pay for a provider round-trip.
   */
  const trapMessages = [
    { code: 'not-found', message: '/var/run/docker.sock: no such file or directory' },
    { code: 'not-found', message: '/tmp/agent.socket not found' },
    { code: 'permission', message: 'cannot open socket: permission denied' },
    { code: 'unknown', message: 'the file was closed before the write completed' },
  ];
  test.each(trapMessages.slice(0, 3))(
    'a mapped code wins over a transport-shaped message: $message',
    (error) => {
      expect(isEnvironmentUnreachable(error)).toBe(false);
    },
  );

  test('an unknown code with a daemon message is still the tool', () => {
    // The daemon answered — it just had nothing better to say. Nothing about
    // the environment is wrong, so re-provisioning it would be superstition.
    expect(
      isEnvironmentUnreachable({ code: 'unknown', message: 'environment error' }),
    ).toBe(false);
  });

  test('a malformed error never crashes the predicate', () => {
    expect(isEnvironmentUnreachable(null)).toBe(false);
    expect(isEnvironmentUnreachable(undefined)).toBe(false);
    expect(isEnvironmentUnreachable('a string')).toBe(false);
    expect(isEnvironmentUnreachable({})).toBe(false);
    expect(isEnvironmentUnreachable({ code: 'unknown' })).toBe(false);
  });

  test('an EnvUnavailableError from a failed attach is not a re-attach trigger', () => {
    // attach() already retried to its own deadline. Looping on it would turn a
    // 3-minute failure into a 6-minute one and tell the model nothing new.
    expect(
      isEnvironmentUnreachable({ code: 'environment_unavailable', message: 'could not attach' }),
    ).toBe(false);
  });
});

/**
 * The contract itself, on a real LazyKortixEnv.
 *
 * Only `attach` is stubbed — the caching, the invalidation and the one-shot
 * bound under test are the real ones.
 */
describe('a tool call whose environment went away', () => {
  interface Harness {
    env: LazyKortixEnv;
    attaches: () => number;
    setBehaviour: (fn: (attachNo: number) => 'ok' | 'gone') => void;
  }

  function harness(): Harness {
    let attaches = 0;
    let behaviour: (n: number) => 'ok' | 'gone' = () => 'ok';
    const env = new LazyKortixEnv({
      apiUrl: 'http://127.0.0.1:1/v1',
      token: 'tok',
      projectId: 'p',
      sessionId: 's',
      cwd: '/workspace',
      ensureTimeoutMs: 50,
    });
    // Stand in for the whole attach: hand back an inner env whose ops answer
    // according to which attach produced it.
    (env as unknown as { attach: () => Promise<unknown> }).attach = async function attach(this: {
      inner: unknown;
    }) {
      if (this.inner) return this.inner;
      attaches += 1;
      const mine = attaches;
      const answer = async () =>
        behaviour(mine) === 'gone'
          ? { ok: false as const, error: { code: 'unknown', message: 'fetch failed' } }
          : { ok: true as const, value: `served-by-attach-${mine}` };
      this.inner = { exec: answer, readTextFile: answer, calls: [] };
      return this.inner;
    };
    return { env, attaches: () => attaches, setBehaviour: (fn) => { behaviour = fn; } };
  }

  test('a healthy environment attaches once and stays', async () => {
    const h = harness();
    await h.env.exec('echo 1');
    await h.env.exec('echo 2');
    await h.env.exec('echo 3');
    expect(h.attaches()).toBe(1);
  });

  /**
   * THE case. The first client is dead; the second one works. Without this the
   * call returns the transport error and every later call does too.
   */
  test('re-attaches and the call SUCCEEDS on the new environment', async () => {
    const h = harness();
    h.setBehaviour((n) => (n === 1 ? 'gone' : 'ok'));
    const r = await h.env.exec('echo hi');
    expect(r).toEqual({ ok: true, value: 'served-by-attach-2' });
    expect(h.attaches()).toBe(2);
  });

  test('the dead client is discarded, not reused by the next call', async () => {
    const h = harness();
    h.setBehaviour((n) => (n === 1 ? 'gone' : 'ok'));
    await h.env.exec('first');
    const second = await h.env.exec('second');
    expect(second).toEqual({ ok: true, value: 'served-by-attach-2' });
    // Still 2: the second call reuses the healthy client rather than probing.
    expect(h.attaches()).toBe(2);
  });

  /**
   * Bounded. If the environment is genuinely unavailable, one retry is the
   * whole budget — attach() already has its own deadline, and looping here
   * would multiply it per tool call.
   */
  test('gives up after ONE re-attach and returns the error', async () => {
    const h = harness();
    h.setBehaviour(() => 'gone');
    const r = await h.env.exec('echo hi');
    expect(r.ok).toBe(false);
    expect(h.attaches()).toBe(2);
  });

  test('an ordinary tool failure never triggers a re-attach', async () => {
    const h = harness();
    (h.env as unknown as { inner: unknown }).inner = {
      exec: async () => ({ ok: false, error: { code: 'not-found', message: 'no such file' } }),
      calls: [],
    };
    const r = await h.env.exec('cat /nope');
    expect(r.ok).toBe(false);
    // Zero attaches: inner was already set, and a tool error must not discard it.
    expect(h.attaches()).toBe(0);
  });
});
