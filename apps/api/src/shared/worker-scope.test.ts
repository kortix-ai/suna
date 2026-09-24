/**
 * A background job's tick runs as a named worker.
 *
 * Nothing drives a worker tick but a timer (or a handler that kicks a drain),
 * so no authenticator ever binds a caller. Every audit row a tick writes used
 * to default to `actor_type: system, source: api` and never named the job.
 * `runWorkerTick` gives each tick its own request context and binds the
 * worker as the principal, so every row written inside inherits it.
 */
import { describe, expect, test } from 'bun:test';
import { getRequestContext, runWithContext } from '../lib/request-context';
import {
  attachInboundAuditScope,
  bindAuditPrincipal,
  currentInboundAuditScope,
  runWorkerTick,
} from './audit-scope';

const USER = '00000000-0000-4000-a000-000000000001';

describe('runWorkerTick', () => {
  test('binds the worker as a system principal with its own request context', async () => {
    const seen = await runWorkerTick('iam-grant-expiry', async () => ({
      principal: currentInboundAuditScope()?.principal,
      owner: currentInboundAuditScope()?.owner,
      entrypoint: currentInboundAuditScope()?.entrypoint,
      route: currentInboundAuditScope()?.route,
      requestId: getRequestContext()?.requestId,
      method: getRequestContext()?.method,
    }));
    expect(seen.principal).toEqual({
      actorUserId: null,
      actorType: 'system',
      authoritativeSource: 'worker',
      authMethod: { kind: 'worker', worker: 'iam-grant-expiry' },
    });
    expect(seen.owner).toBe('worker');
    expect(seen.entrypoint).toBe('worker');
    expect(seen.route).toBe('worker:iam-grant-expiry');
    expect(seen.method).toBe('WORKER');
    expect(typeof seen.requestId).toBe('string');
  });

  test('each tick gets a fresh request id, so its rows correlate with each other only', async () => {
    const first = await runWorkerTick('trigger-scheduler', async () => getRequestContext()?.requestId);
    const second = await runWorkerTick('trigger-scheduler', async () => getRequestContext()?.requestId);
    expect(first).not.toBe(second);
  });

  test('a drain kicked from a request runs as the worker, never as the caller', async () => {
    const principal = await runWithContext('POST', '/v1/projects/p/sessions', async () => {
      attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      bindAuditPrincipal({ actorUserId: USER, actorType: 'human', authoritativeSource: 'human' });
      return runWorkerTick('session-lifecycle', async () => currentInboundAuditScope()?.principal);
    });
    expect(principal).toMatchObject({ actorType: 'system', actorUserId: null, authoritativeSource: 'worker' });
  });

  test('the caller keeps its own scope after the tick returns', async () => {
    await runWithContext('POST', '/v1/x', async () => {
      const outer = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      bindAuditPrincipal({ actorUserId: USER, actorType: 'human' });
      await runWorkerTick('session-lifecycle', async () => undefined);
      expect(currentInboundAuditScope()).toBe(outer);
      expect(outer.principal.actorUserId).toBe(USER);
    });
  });

  test('returns the tick result and propagates its error', async () => {
    expect(await runWorkerTick('w', async () => 42)).toBe(42);
    await expect(runWorkerTick('w', async () => {
      throw new Error('tick failed');
    })).rejects.toThrow('tick failed');
  });

  test('synchronous ticks work too', async () => {
    expect(await runWorkerTick('w', () => 7)).toBe(7);
  });
});
