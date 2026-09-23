import { describe, expect, test } from 'bun:test';
import { runWithContext } from '../lib/request-context';
import {
  annotateAuditEvent,
  attachInboundAuditScope,
  bindAuditPrincipal,
  bindIntegrationPrincipal,
  currentInboundAuditScope,
  isUnauditedInbound,
  setInboundAuditEntrypoint,
} from './audit-scope';

const USER = '00000000-0000-4000-a000-000000000001';
const ACCOUNT = '00000000-0000-4000-a000-000000000101';

function inRequest<T>(fn: () => T): T {
  return runWithContext('POST', '/v1/git/p.git/git-receive-pack', fn);
}

describe('inbound audit scope', () => {
  test('outside a request there is no scope, and binding is a harmless no-op', () => {
    expect(currentInboundAuditScope()).toBeUndefined();
    expect(() => bindAuditPrincipal({ actorUserId: USER })).not.toThrow();
    expect(() => annotateAuditEvent({ action: 'git.push' })).not.toThrow();
  });

  test('a scope attached inside a request is visible to everything the request calls', () =>
    inRequest(async () => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      await Promise.resolve();
      expect(currentInboundAuditScope()).toBe(scope);
    }));

  test('a second attach in the same request returns the existing scope, never a new one', () =>
    inRequest(() => {
      const first = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      const second = attachInboundAuditScope({ owner: 'hono', method: 'POST' });
      expect(second).toBe(first);
      expect(second.owner).toBe('edge');
    }));

  test('concurrent requests never see each other’s scope', async () => {
    const seen: Array<string | null | undefined> = [];
    await Promise.all(
      [USER, ACCOUNT].map((id) =>
        runWithContext('GET', `/v1/x/${id}`, async () => {
          attachInboundAuditScope({ owner: 'edge', method: 'GET' });
          bindAuditPrincipal({ actorUserId: id });
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.push(currentInboundAuditScope()?.principal.actorUserId);
        }),
      ),
    );
    expect(seen.sort()).toEqual([USER, ACCOUNT].sort());
  });

  test('a bind sets only the fields it names; undefined never erases a known value', () =>
    inRequest(() => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      bindAuditPrincipal({ actorUserId: USER, accountId: ACCOUNT, actorType: 'human' });
      bindAuditPrincipal({ actorType: 'agent', accountId: undefined });
      expect(scope.principal).toMatchObject({
        actorUserId: USER,
        accountId: ACCOUNT,
        actorType: 'agent',
      });
    }));

  test('an explicit null is a statement ("known to be none") and is kept', () =>
    inRequest(() => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      bindAuditPrincipal({ actorUserId: USER });
      bindAuditPrincipal({ actorUserId: null });
      expect(scope.principal.actorUserId).toBeNull();
    }));

  test('annotations override the action and merge metadata instead of replacing it', () =>
    inRequest(() => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      annotateAuditEvent({ action: 'git.push', metadata: { via: 'git_proxy' } });
      annotateAuditEvent({ metadata: { refs: [{ ref: 'refs/heads/main' }] } });
      expect(scope.annotation.action).toBe('git.push');
      expect(scope.annotation.metadata).toEqual({
        via: 'git_proxy',
        refs: [{ ref: 'refs/heads/main' }],
      });
    }));

  test('the entrypoint and route class can be set by the dispatcher that knows them', () =>
    inRequest(() => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'GET' });
      expect(scope.entrypoint).toBe('http');
      setInboundAuditEntrypoint('preview_origin', 'preview_origin:p3000');
      expect(scope.entrypoint).toBe('preview_origin');
      expect(scope.route).toBe('preview_origin:p3000');
    }));
});

describe('traffic that is never audited', () => {
  // Every other request is audited. Keep this list short: each entry is a
  // decision that a class of traffic carries no principal action.
  test.each([
    ['OPTIONS', '/v1/projects'], // CORS preflight
    ['GET', '/health'],
    ['GET', '/health/live'],
    ['GET', '/health/ready'],
    ['GET', '/v1/health'],
    ['GET', '/v1/health/live'],
    ['GET', '/v1/health/ready'],
    ['GET', '/metrics'],
    ['GET', '/v1/openapi.json'],
    ['GET', '/v1/docs'],
  ])('%s %s is probe or preflight noise', (method, path) => {
    expect(isUnauditedInbound(method, path)).toBe(true);
  });

  test.each([
    ['POST', '/v1/git/p.git/git-receive-pack'],
    ['GET', '/v1/git/p.git/info/refs'],
    ['POST', '/scim/v2/Users'],
    ['POST', '/v1/webhooks/slack/p'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/v1/healthcheck-lookalike'],
    ['GET', '/'],
  ])('%s %s is audited', (method, path) => {
    expect(isUnauditedInbound(method, path)).toBe(false);
  });
});

describe('an external system that proved itself', () => {
  test('a verified webhook is the integration, acting for the account it names', () =>
    inRequest(() => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      bindIntegrationPrincipal('slack');
      bindIntegrationPrincipal('slack', { accountId: ACCOUNT, projectId: USER });
      expect(scope.principal).toEqual({
        accountId: ACCOUNT,
        projectId: USER,
        actorUserId: null,
        actorType: 'system',
        authoritativeSource: 'integration',
        authMethod: { kind: 'webhook_signature', provider: 'slack' },
      });
    }));

  test('without a request it does nothing', () => {
    expect(() => bindIntegrationPrincipal('stripe')).not.toThrow();
  });
});
