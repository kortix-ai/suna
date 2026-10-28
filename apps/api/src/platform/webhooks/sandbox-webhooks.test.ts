import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import * as realSandboxReaper from '../../projects/sandbox-reaper';

const cfg: { PLATINUM_WEBHOOK_SECRET?: string } = {};
let stoppedCalls: string[] = [];
let stoppedOptions: Array<Record<string, unknown> | undefined> = [];
let removedCalls: string[] = [];
let dedupSeen: Set<string> = new Set();

mock.module('../../config', () => ({ config: cfg }));
mock.module('../../billing/services/webhook-concurrency', () => ({
  recordWebhookEvent: async (id: string) => {
    if (dedupSeen.has(id)) return false;
    dedupSeen.add(id);
    return true;
  },
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../projects/sandbox-reaper', () => ({
  ...realSandboxReaper,
  reconcileSandboxStoppedByExternalId: async (
    externalId: string,
    _now?: Date,
    options?: Record<string, unknown>,
  ) => {
    stoppedCalls.push(externalId);
    stoppedOptions.push(options);
    return true;
  },
  reconcileSandboxRemovedByExternalId: async (externalId: string) => {
    removedCalls.push(externalId);
    return true;
  },
}));

const {
  classifyLifecycle,
  verifyHmacSha256,
  handlePlatinumWebhook,
} = await import('./sandbox-webhooks');

beforeEach(() => {
  cfg.PLATINUM_WEBHOOK_SECRET = undefined;
  stoppedCalls = [];
  stoppedOptions = [];
  removedCalls = [];
  dedupSeen = new Set();
});

describe('classifyLifecycle', () => {
  test('terminal states → stopped', () => {
    for (const s of ['stopped', 'stopping', 'archived', 'archiving']) {
      expect(classifyLifecycle(s, 'sandbox.state.updated')).toBe('stopped');
    }
  });
  test('destroyed/deleted/lost or delete event → removed', () => {
    expect(classifyLifecycle('deleted', 'x')).toBe('removed');
    expect(classifyLifecycle('lost', 'x')).toBe('removed');
    expect(classifyLifecycle(undefined, 'sandbox.deleted')).toBe('removed');
  });
  test('started/running/creating → noop', () => {
    for (const s of ['started', 'running', 'creating', 'resuming']) {
      expect(classifyLifecycle(s, 'sandbox.state.updated')).toBe('noop');
    }
  });
});

describe('verifyHmacSha256 (Platinum)', () => {
  const secret = 'whsec_platinum_test';
  const body = '{"id":"sb1","state":"stopped"}';
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  test('accepts a correct hex signature', () => {
    expect(verifyHmacSha256(body, secret, sig)).toBe(true);
  });
  test('accepts sha256= / v1= prefixed', () => {
    expect(verifyHmacSha256(body, secret, `sha256=${sig}`)).toBe(true);
    expect(verifyHmacSha256(body, secret, `v1=${sig}`)).toBe(true);
  });
  test('rejects a wrong signature / missing header', () => {
    expect(verifyHmacSha256(body, secret, 'deadbeef')).toBe(false);
    expect(verifyHmacSha256(body, secret, undefined)).toBe(false);
    expect(verifyHmacSha256(body + 'x', secret, sig)).toBe(false);
  });
});

describe('handlePlatinumWebhook', () => {
  const secret = 'whsec_plat';
  function hmacHeader(body: string): (h: string) => string | undefined {
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return (h: string) => (h.toLowerCase() === 'x-platinum-signature' ? sig : undefined);
  }
  test('503 when not configured', async () => {
    const r = await handlePlatinumWebhook('{}', () => undefined);
    expect(r.status).toBe(503);
  });
  test('removes on a delete event', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.deleted', id: 'pX', state: 'deleted' });
    const r = await handlePlatinumWebhook(body, hmacHeader(body));
    expect(r.status).toBe(200);
    expect(removedCalls).toEqual(['pX']);
  });
  // `classifyLifecycle` folds `stopping` and `archiving` — both TRANSITIONAL —
  // into `stopped`. A delivery is an unsolicited observation, so mid-turn it
  // must be confirmed by a second one before the box is durably parked
  // (incident 2026-08-17T20:40:03Z, a prod session: one such observation
  // parked a running turn with `stopReason: provider_reconcile`).
  test('a stopped delivery is an OBSERVATION, and says so', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state_updated', id: 'pC', state: 'stopping' });
    await handlePlatinumWebhook(body, hmacHeader(body));
    expect(stoppedCalls).toEqual(['pC']);
    expect(stoppedOptions).toEqual([{ confirmMidTurnStop: true }]);
  });
  test('dedupes a repeated delivery', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state_updated', id: 'pB', state: 'stopped' });
    await handlePlatinumWebhook(body, hmacHeader(body));
    await handlePlatinumWebhook(body, hmacHeader(body));
    expect(stoppedCalls).toEqual(['pB']); // second is deduped
  });
  test('noop on started', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state_updated', id: 'pY', state: 'running' });
    const r = await handlePlatinumWebhook(body, hmacHeader(body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual([]);
    expect(removedCalls).toEqual([]);
  });
});

describe('a sandbox provider delivery names the provider in the request audit', () => {
  // Provider webhooks are signed, public routes: no auth middleware names the
  // caller. Only a delivery whose signature verified may be attributed to the
  // provider; a forged one stays anonymous and is recorded as denied.
  const { runWithContext } = require('../../lib/request-context');
  const { attachInboundAuditScope } = require('../../shared/audit-scope');
  const secret = 'whsec_plat';

  async function principalAfter(sig: string) {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ type: 'sandbox.deleted', data: { id: 'sbA' } });
    return runWithContext('POST', '/v1/webhooks/sandbox/platinum', async () => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
      const header = sig === 'valid' ? createHmac('sha256', secret).update(body, 'utf8').digest('hex') : sig;
      const result = await handlePlatinumWebhook(body, (h: string) =>
        h.toLowerCase() === 'x-platinum-signature' ? header : undefined,
      );
      return { status: result.status, principal: scope.principal };
    });
  }

  test('a verified delivery is the provider acting', async () => {
    const { status, principal } = await principalAfter('valid');
    expect(status).toBe(200);
    expect(principal).toMatchObject({
      actorType: 'system',
      authoritativeSource: 'integration',
      authMethod: { kind: 'webhook_signature', provider: 'platinum' },
    });
  });

  test('a forged delivery is refused and names nobody', async () => {
    const { status, principal } = await principalAfter('0'.repeat(64));
    expect(status).toBe(401);
    expect(principal).toEqual({});
  });
});
