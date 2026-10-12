import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Composio } from '@composio/core';
import { config } from '../../config';
import { setComposioRuntimeForTest, type ComposioRuntime } from '../../connectors/composio';
import { composioEventSource as provider, composioErrorMessage } from './composio';
import { setComposioRestClientForTest } from '../../connectors/composio-catalog-search';
import { eventSourceFor } from './registry';
import { EventSignatureError, EventConnectionNotReadyError } from './types';

const SECRET = 'test-secret-not-base64!';
const writable = config as { COMPOSIO_WEBHOOK_SECRET?: string };
let prevSecret: string | undefined;
let prevKey: string | undefined;

const calls: Array<[string, ...unknown[]]> = [];
let listPages: Array<{ items: unknown[]; nextCursor?: string | null }> = [];
let deleteError: unknown = null;
const CONNECTION = '00000000-0000-4000-a000-0000000000c1';

function installRuntime() {
  setComposioRuntimeForTest({
    triggers: {
      async listTypes(q: unknown) { calls.push(['listTypes', q]); return listPages.shift() as never; },
      async create(...a: unknown[]) { calls.push(['create', ...a]); return { triggerId: 'ti_synthetic1' }; },
      async delete(id: string) { calls.push(['delete', id]); if (deleteError) throw deleteError; return { triggerId: id }; },
    },
    connectedAccounts: {
      async get(id: string) { calls.push(['getAccount', id]); return id === 'ca_known' ? { user_id: `kortix-connection:${CONNECTION}` } : null; },
    },
  } as unknown as ComposioRuntime);
}

beforeEach(() => {
  prevSecret = writable.COMPOSIO_WEBHOOK_SECRET;
  prevKey = process.env.COMPOSIO_API_KEY;
  writable.COMPOSIO_WEBHOOK_SECRET = SECRET;
  process.env.COMPOSIO_API_KEY = 'test-key';
  calls.length = 0;
  listPages = [];
  deleteError = null;
  installRuntime();
});
afterEach(() => {
  writable.COMPOSIO_WEBHOOK_SECRET = prevSecret;
  if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = prevKey;
  setComposioRuntimeForTest(null);
});

function sign(body: string, opts: { id?: string; ts?: number; secret?: string } = {}) {
  const id = opts.id ?? 'msg_synthetic1';
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${id}.${ts}.${body}`).digest('base64');
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` });
}
const v3 = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'msg_evt1', type, timestamp: '2026-01-01T00:00:00Z',
    metadata: { trigger_id: 'ti_synthetic1', trigger_slug: 'GITHUB_PULL_REQUEST_EVENT', connected_account_id: 'ca_1', user_id: 'u', log_id: 'log_1' },
    data: { action: 'opened' }, ...extra,
  });

describe('registry', () => {
  test('resolves composio only', () => {
    expect(eventSourceFor('composio')).toBe(provider);
    expect(eventSourceFor('nope')).toBeNull();
  });
});

describe('configured', () => {
  test('flags', () => {
    expect(provider.configured()).toBe(true);
    expect(provider.ingressConfigured()).toBe(true);
    writable.COMPOSIO_WEBHOOK_SECRET = undefined;
    expect(provider.ingressConfigured()).toBe(false);
  });
});

describe('listEventTypes', () => {
  test('maps fields and paginates', async () => {
    const item = (slug: string, type: string) => ({
      slug, name: slug, description: 'd', type, toolkit: { slug: 'github', name: 'GitHub' },
      config: { type: 'object', properties: { repo: { type: 'string' } } }, payload: { type: 'object' },
    });
    listPages = [
      { items: [item('A', 'poll'), item('B', 'webhook')], nextCursor: 'c2' },
      { items: [{ ...item('C', 'other'), payload: {} }, { ...item('D', undefined as unknown as string), config: { properties: { interval: { type: 'number' } } } }], nextCursor: null },
    ];
    const types = await provider.listEventTypes('github');
    expect(types.map((t) => [t.type, t.delivery])).toEqual([['A', 'poll'], ['B', 'push'], ['C', null], ['D', 'poll']]);
    expect(types[0]).toMatchObject({ app: 'github', configSchema: { type: 'object', properties: { repo: { type: 'string' } } }, payloadSchema: { type: 'object' } });
    expect(types[2]!.payloadSchema).toBeNull();
    expect(calls[0]![1]).toMatchObject({ toolkits: ['github'] });
    expect(calls[1]![1]).toMatchObject({ cursor: 'c2' });
  });
});

describe('listApps', () => {
  const toolkit = (slug: string, name: string, triggers: number, extra: Record<string, unknown> = {}) => ({
    slug, name, auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], meta: { triggers_count: triggers, ...(slug === 'zeta' ? { logo: 'z.png' } : {}) }, ...extra,
  });
  afterEach(() => setComposioRestClientForTest(null));

  test('pages the whole catalogue, drops hidden toolkits and those without events, sorts by name', async () => {
    const cursors: Array<string | undefined> = [];
    setComposioRestClientForTest({
      toolkits: {
        async list(q: { cursor?: string }) {
          cursors.push(q.cursor);
          return q.cursor
            ? { items: [toolkit('late', 'Late', 3), toolkit('byo', 'Byo', 4, { composio_managed_auth_schemes: [] })], next_cursor: null }
            : { items: [toolkit('zeta', 'Zeta', 2), toolkit('none', 'None', 0), toolkit('alpha', 'Alpha', 5)], next_cursor: 'p2' };
        },
      },
    });
    expect(await provider.listApps()).toEqual([
      { app: 'alpha', name: 'Alpha', logo: null, eventCount: 5 },
      { app: 'late', name: 'Late', logo: null, eventCount: 3 },
      { app: 'zeta', name: 'Zeta', logo: 'z.png', eventCount: 2 },
    ]);
    expect(cursors).toEqual([undefined, 'p2']);
  });
});

describe('subscribe / unsubscribe', () => {
  const connection = { connectionId: 'conn-1', connectorSlug: 'github', app: 'github', metadata: { connected_account_id: 'ca_1' } };
  test('passes user id, slug, connected account and config', async () => {
    const res = await provider.subscribe({ connection, type: 'GITHUB_PULL_REQUEST_EVENT', config: { repo: 'api' } });
    expect(res).toEqual({ externalId: 'ti_synthetic1' });
    expect(calls[0]).toEqual(['create', 'kortix-connection:conn-1', 'GITHUB_PULL_REQUEST_EVENT', { connectedAccountId: 'ca_1', triggerConfig: { repo: 'api' } }]);
  });
  test('an unauthorized connection (no connected_account_id) is not ready', async () => {
    await expect(provider.subscribe({ connection: { ...connection, metadata: {} }, type: 'X', config: {} })).rejects.toBeInstanceOf(EventConnectionNotReadyError);
    expect(calls).toHaveLength(0);
  });
  test('connectionReady is true only with a connected account id', () => {
    expect(provider.connectionReady?.(connection)).toBe(true);
    expect(provider.connectionReady?.({ ...connection, metadata: {} })).toBe(false);
  });
  test('unsubscribe deletes; 404 is success; other errors throw', async () => {
    await provider.unsubscribe('ti_1');
    expect(calls[0]).toEqual(['delete', 'ti_1']);
    deleteError = Object.assign(new Error('not found'), { status: 404 });
    await provider.unsubscribe('ti_1');
    deleteError = Object.assign(new Error('boom'), { status: 500 });
    await expect(provider.unsubscribe('ti_1')).rejects.toThrow('boom');
  });
});

describe('receive: signature', () => {
  const body = v3('composio.trigger.message');
  test('the SDK own verifyWebhook accepts what we accept', async () => {
    const headers = sign(body);
    const sdk = new Composio({ apiKey: 'test-key', allowTracking: false });
    const verified = await sdk.triggers.verifyWebhook({
      id: headers.get('webhook-id')!, timestamp: headers.get('webhook-timestamp')!,
      signature: headers.get('webhook-signature')!, payload: body, secret: SECRET,
    });
    expect(verified.version).toBe('V3');
    expect((await provider.receive({ headers, rawBody: body })).deliveries).toHaveLength(1);
  });
  test('accepts one of several space-separated signatures', async () => {
    const h = sign(body);
    h.set('webhook-signature', `v1,AAAA ${h.get('webhook-signature')}`);
    expect((await provider.receive({ headers: h, rawBody: body })).deliveries).toHaveLength(1);
  });
  test.each([
    ['tampered body', () => ({ headers: sign(body), rawBody: body + ' ' })],
    ['wrong secret', () => ({ headers: sign(body, { secret: 'other' }), rawBody: body })],
    ['stale timestamp', () => ({ headers: sign(body, { ts: Math.floor(Date.now() / 1000) - 400 }), rawBody: body })],
    ['missing headers', () => ({ headers: new Headers(), rawBody: body })],
  ])('rejects %s', async (_n, make) => {
    await expect(provider.receive(make())).rejects.toBeInstanceOf(EventSignatureError);
  });
  test('rejects when no secret is configured', async () => {
    writable.COMPOSIO_WEBHOOK_SECRET = undefined;
    await expect(provider.receive({ headers: sign(body), rawBody: body })).rejects.toBeInstanceOf(EventSignatureError);
  });
});

describe('receive: parsing', () => {
  const run = (body: string, id?: string) => provider.receive({ headers: sign(body, { id }), rawBody: body });
  test('trigger message becomes a delivery', async () => {
    const r = await run(v3('composio.trigger.message'));
    expect(r.notices).toEqual([]);
    expect(r.deliveries).toEqual([{ externalId: 'ti_synthetic1', eventId: 'msg_evt1', type: 'GITHUB_PULL_REQUEST_EVENT', occurredAt: '2026-01-01T00:00:00Z', data: { action: 'opened' } }]);
  });
  test('eventId falls back to webhook-id', async () => {
    expect((await run(v3('composio.trigger.message', { id: undefined }), 'msg_hdr')).deliveries[0]!.eventId).toBe('msg_hdr');
  });
  test('disabled and expired become notices', async () => {
    const d = await run(v3('composio.trigger.disabled', { data: { reason: 'auth failed' } }));
    expect(d.deliveries).toEqual([]);
    expect(d.notices).toEqual([{ kind: 'subscription_disabled', externalId: 'ti_synthetic1', reason: 'auth failed' }]);
    const e = await run(v3('composio.connected_account.expired'));
    expect(e.notices).toMatchObject([{ kind: 'connection_expired', connectionExternalId: 'ca_1' }]);
  });
  test('an activated account names its Kortix connection, wherever the payload puts the user id', async () => {
    const inData = await run(v3('composio.connected_account.activated', { metadata: {}, data: { id: 'ca_x', user_id: `kortix-connection:${CONNECTION}` } }));
    expect(inData.notices).toEqual([{ kind: 'connection_activated', connectionId: CONNECTION }]);
    const inMeta = await run(v3('composio.connected_account.activated', { metadata: { user_id: `kortix-connection:${CONNECTION}` }, data: {} }));
    expect(inMeta.notices).toEqual([{ kind: 'connection_activated', connectionId: CONNECTION }]);
    expect(calls.filter((c) => c[0] === 'getAccount')).toEqual([]);
  });
  test('without a user id in the payload the account is read; a foreign user id is ignored', async () => {
    const read = await run(v3('composio.connected_account.activated', { metadata: { connected_account_id: 'ca_known' }, data: {} }));
    expect(read.notices).toEqual([{ kind: 'connection_activated', connectionId: CONNECTION }]);
    expect(calls).toContainEqual(['getAccount', 'ca_known']);
    const foreign = await run(v3('composio.connected_account.activated', { metadata: { user_id: 'someone-else' }, data: { id: 'ca_unknown' } }));
    expect(foreign.notices).toEqual([]);
  });
  test('unknown type is ignored; malformed JSON after a valid signature is empty', async () => {
    expect(await run(v3('composio.something.else'))).toEqual({ deliveries: [], notices: [] });
    expect(await run('not json')).toEqual({ deliveries: [], notices: [] });
  });
});

describe('composioErrorMessage', () => {
  test('reads the Composio message and the nested upstream validation message', () => {
    const nested = JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'The listed repositories cannot be searched.' }] });
    const raw = `400 ${JSON.stringify({ error: { message: `Invalid polling configuration for trigger "X": ${nested}`, code: 1213 } })}`;
    expect(composioErrorMessage(new Error(raw))).toBe('Invalid polling configuration for trigger "X": The listed repositories cannot be searched.');
  });
  test('a plain Composio message and a non-JSON error pass through', () => {
    expect(composioErrorMessage(new Error('404 {"error":{"message":"Trigger not found"}}'))).toBe('Trigger not found');
    expect(composioErrorMessage(new Error('socket hang up'))).toBe('socket hang up');
  });
});
