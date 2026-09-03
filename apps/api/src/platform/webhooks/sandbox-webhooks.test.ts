import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import * as realSandboxReaper from '../../projects/sandbox-reaper';

const cfg: { DAYTONA_WEBHOOK_SECRET?: string; PLATINUM_WEBHOOK_SECRET?: string } = {};
let stoppedCalls: string[] = [];
let stoppedOptions: Array<Record<string, unknown> | undefined> = [];
let removedCalls: string[] = [];
let environmentStoppedCalls: string[] = [];
let environmentRemovedCalls: string[] = [];
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
mock.module('../services/session-environment-state-sync', () => ({
  reconcileEnvironmentStoppedByExternalId: async (externalId: string) => {
    environmentStoppedCalls.push(externalId);
    return true;
  },
  reconcileEnvironmentRemovedByExternalId: async (externalId: string) => {
    environmentRemovedCalls.push(externalId);
    return true;
  },
}));

const {
  classifyLifecycle,
  verifyHmacSha256,
  verifySvix,
  handleDaytonaWebhook,
  handlePlatinumWebhook,
} = await import('./sandbox-webhooks');

beforeEach(() => {
  cfg.DAYTONA_WEBHOOK_SECRET = undefined;
  cfg.PLATINUM_WEBHOOK_SECRET = undefined;
  stoppedCalls = [];
  stoppedOptions = [];
  removedCalls = [];
  environmentStoppedCalls = [];
  environmentRemovedCalls = [];
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

describe('verifySvix (Daytona)', () => {
  const secretRaw = Buffer.from('daytona-test-key').toString('base64');
  const secret = `whsec_${secretRaw}`;
  const id = 'msg_1';
  const ts = '1700000000';
  const body = '{"event":"sandbox.state.updated","id":"sb2","newState":"stopped"}';
  const expected = createHmac('sha256', Buffer.from(secretRaw, 'base64'))
    .update(`${id}.${ts}.${body}`, 'utf8')
    .digest('base64');
  test('accepts a correct v1 signature', () => {
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: `v1,${expected}` })).toBe(true);
  });
  test('rejects wrong / incomplete', () => {
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: 'v1,nope' })).toBe(false);
    expect(
      verifySvix(body, secret, { id: undefined, timestamp: ts, signature: `v1,${expected}` }),
    ).toBe(false);
  });
});

function svixHeaders(
  secret: string,
  id: string,
  ts: string,
  body: string,
): (h: string) => string | undefined {
  const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
    .update(`${id}.${ts}.${body}`, 'utf8')
    .digest('base64');
  const map: Record<string, string> = {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${sig}`,
  };
  return (h: string) => map[h.toLowerCase()];
}

describe('handleDaytonaWebhook', () => {
  const secret = `whsec_${Buffer.from('k').toString('base64')}`;
  test('503 when not configured', async () => {
    const r = await handleDaytonaWebhook('{}', () => undefined);
    expect(r.status).toBe(503);
  });
  test('401 on bad signature', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const r = await handleDaytonaWebhook('{"id":"sb"}', () => 'bad');
    expect(r.status).toBe(401);
  });
  test('closes billing on a stopped state', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({
      event: 'sandbox.state.updated',
      id: 'sbA',
      newState: 'stopped',
      updatedAt: 't1',
    });
    const r = await handleDaytonaWebhook(body, svixHeaders(secret, 'm1', '100', body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual(['sbA']);
    expect(environmentStoppedCalls).toEqual(['sbA']);
  });
  // `classifyLifecycle` folds `stopping` and `archiving` — both TRANSITIONAL —
  // into `stopped`. A delivery is an unsolicited observation, so mid-turn it
  // must be confirmed by a second one before the box is durably parked
  // (incident 2026-08-17T20:40:03Z, session 0fc6897a: one such observation
  // parked a running turn with `stopReason: provider_reconcile`).
  test('a stopped delivery is an OBSERVATION, and says so', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({
      event: 'sandbox.state.updated',
      id: 'sbC',
      newState: 'stopping',
      updatedAt: 't1',
    });
    await handleDaytonaWebhook(body, svixHeaders(secret, 'm3', '100', body));

    expect(stoppedCalls).toEqual(['sbC']);
    expect(stoppedOptions).toEqual([{ confirmMidTurnStop: true }]);
  });
  test('dedupes a repeated delivery', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({
      event: 'sandbox.state.updated',
      id: 'sbB',
      newState: 'stopped',
      updatedAt: 't1',
    });
    const hdr = svixHeaders(secret, 'm2', '100', body);
    await handleDaytonaWebhook(body, hdr);
    await handleDaytonaWebhook(body, hdr);
    expect(stoppedCalls).toEqual(['sbB']); // second is deduped
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
    expect(environmentRemovedCalls).toEqual(['pX']);
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
