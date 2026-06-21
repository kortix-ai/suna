import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';

const cfg: { DAYTONA_WEBHOOK_SECRET?: string; PLATINUM_WEBHOOK_SECRET?: string } = {};
let stoppedCalls: string[] = [];
let removedCalls: string[] = [];
let dedupSeen: Set<string> = new Set();
let throwDedup = false;

mock.module('../../config', () => ({ config: cfg }));
mock.module('../../billing/services/webhook-concurrency', () => ({
  recordWebhookEvent: async (id: string) => {
    if (throwDedup) throw new Error('dedupe down');
    if (dedupSeen.has(id)) return false;
    dedupSeen.add(id);
    return true;
  },
}));
mock.module('../../projects/sandbox-reaper', () => ({
  reconcileSandboxStoppedByExternalId: async (externalId: string) => {
    stoppedCalls.push(externalId);
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
  verifySvix,
  handleDaytonaWebhook,
  handlePlatinumWebhook,
} = await import('./sandbox-webhooks');

beforeEach(() => {
  cfg.DAYTONA_WEBHOOK_SECRET = undefined;
  cfg.PLATINUM_WEBHOOK_SECRET = undefined;
  stoppedCalls = [];
  removedCalls = [];
  dedupSeen = new Set();
  throwDedup = false;
});

describe('classifyLifecycle', () => {
  test('terminal states → stopped', () => {
    for (const s of ['stopped', 'archived']) {
      expect(classifyLifecycle(s, 'sandbox.state.updated')).toBe('stopped');
    }
  });
  test('transitional stop/archive states → noop until terminal', () => {
    for (const s of ['stopping', 'archiving']) {
      expect(classifyLifecycle(s, 'sandbox.state.updated')).toBe('noop');
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
  const body = '{"event":"sandbox.state.updated","id":"sb2","newState":"stopped"}';
  function sign(ts: string): string {
    return createHmac('sha256', Buffer.from(secretRaw, 'base64'))
      .update(`${id}.${ts}.${body}`, 'utf8')
      .digest('base64');
  }
  test('accepts a correct v1 signature', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const expected = sign(ts);
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: `v1,${expected}` })).toBe(true);
  });
  test('rejects wrong / incomplete', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const expected = sign(ts);
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: 'v1,nope' })).toBe(false);
    expect(verifySvix(body, secret, { id: undefined, timestamp: ts, signature: `v1,${expected}` })).toBe(false);
  });
  test('rejects stale signed deliveries', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifySvix(body, secret, { id, timestamp: ts, signature: `v1,${sign(ts)}` })).toBe(false);
  });
});

function svixHeaders(secret: string, id: string, ts: string, body: string): (h: string) => string | undefined {
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
    const body = JSON.stringify({ event: 'sandbox.state.updated', id: 'sbA', newState: 'stopped', updatedAt: 't1' });
    const r = await handleDaytonaWebhook(body, svixHeaders(secret, 'm1', String(Math.floor(Date.now() / 1000)), body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual(['sbA']);
  });
  test('dedupes a repeated delivery', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state.updated', id: 'sbB', newState: 'stopped', updatedAt: 't1' });
    const hdr = svixHeaders(secret, 'm2', String(Math.floor(Date.now() / 1000)), body);
    await handleDaytonaWebhook(body, hdr);
    await handleDaytonaWebhook(body, hdr);
    expect(stoppedCalls).toEqual(['sbB']); // second is deduped
  });
  test('fails closed when dedupe storage is unavailable', async () => {
    cfg.DAYTONA_WEBHOOK_SECRET = secret;
    throwDedup = true;
    const body = JSON.stringify({ event: 'sandbox.state.updated', id: 'sbC', newState: 'stopped', updatedAt: 't1' });
    const r = await handleDaytonaWebhook(body, svixHeaders(secret, 'm3', String(Math.floor(Date.now() / 1000)), body));
    expect(r.status).toBe(503);
    expect(stoppedCalls).toEqual([]);
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
  test('noop on started', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ event: 'sandbox.state_updated', id: 'pY', state: 'running' });
    const r = await handlePlatinumWebhook(body, hmacHeader(body));
    expect(r.status).toBe(200);
    expect(stoppedCalls).toEqual([]);
    expect(removedCalls).toEqual([]);
  });
  test('does not dedupe distinct lifecycle events for the same sandbox id', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    const created = JSON.stringify({ event: 'sandbox.created', id: 'pZ', state: 'running' });
    const deleted = JSON.stringify({ event: 'sandbox.deleted', id: 'pZ', state: 'deleted' });
    await handlePlatinumWebhook(created, hmacHeader(created));
    const r = await handlePlatinumWebhook(deleted, hmacHeader(deleted));
    expect(r.status).toBe(200);
    expect(removedCalls).toEqual(['pZ']);
  });
  test('fails closed when dedupe storage is unavailable', async () => {
    cfg.PLATINUM_WEBHOOK_SECRET = secret;
    throwDedup = true;
    const body = JSON.stringify({ event: 'sandbox.deleted', id: 'pErr', state: 'deleted' });
    const r = await handlePlatinumWebhook(body, hmacHeader(body));
    expect(r.status).toBe(503);
    expect(removedCalls).toEqual([]);
  });
});
