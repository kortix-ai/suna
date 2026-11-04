import { afterEach, describe, expect, test } from 'bun:test';
import {
  edgeSyncPlan,
  syncWorkerEdgeKey,
  verifyInternalEdgeEngagement,
} from './sync-worker-edge-key.mjs';

const ACCOUNT_ID = 'acc123';
const WORKER = 'api-kortix-router';
const ORIGIN = 'https://api.kortix.com';
const SECRETS_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER}/secrets`;
const PROBE_URL = `${ORIGIN}/internal/gateway/models`;

let requests;
let fetchStub;

function installFetch(secrets, probeStatuses) {
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  requests = [];
  const statuses = Array.isArray(probeStatuses) ? [...probeStatuses] : probeStatuses;
  fetchStub = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if (String(url) === PROBE_URL) {
      const status = Array.isArray(statuses) ? statuses.shift() : statuses;
      return new Response(null, { status });
    }
    if (String(url) === SECRETS_URL && !options.method) {
      return Response.json({ success: true, result: secrets.map((name) => ({ name })) });
    }
    if (String(url) === SECRETS_URL && options.method === 'PUT') {
      const { name } = JSON.parse(options.body);
      if (!secrets.includes(name)) secrets.push(name);
      return Response.json({ success: true, result: null });
    }
    if (String(url) === `${SECRETS_URL}/INTERNAL_EDGE_KEY` && options.method === 'DELETE') {
      secrets.splice(secrets.indexOf('INTERNAL_EDGE_KEY'), 1);
      return Response.json({ success: true, result: null });
    }
    return Response.json(
      { success: false, errors: [{ message: 'unexpected call' }] },
      { status: 400 },
    );
  };
  globalThis.fetch = fetchStub;
}

const originalFetch = globalThis.fetch;
const originalToken = process.env.CLOUDFLARE_API_TOKEN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.CLOUDFLARE_API_TOKEN = originalToken;
});

describe('edgeSyncPlan', () => {
  test('sets when the blob names the key and deletes when it does not', () => {
    expect(edgeSyncPlan(' edge-key-value-that-is-long-enough ')).toEqual({
      action: 'set',
      engaged: true,
      edgeKey: 'edge-key-value-that-is-long-enough',
    });
    expect(edgeSyncPlan(undefined)).toEqual({ action: 'delete', engaged: false, edgeKey: '' });
    expect(edgeSyncPlan('   ')).toEqual({ action: 'delete', engaged: false, edgeKey: '' });
  });

  test('refuses a key shorter than the app boots with', () => {
    expect(() => edgeSyncPlan('too-short-key')).toThrow('want >= 24');
  });
});

describe('syncWorkerEdgeKey', () => {
  test('puts the secret when the blob names the key and verifies it persisted', async () => {
    const secrets = ['ACTIVE_BACKEND'];
    installFetch(secrets);
    const result = await syncWorkerEdgeKey({
      accountId: ACCOUNT_ID,
      workerName: WORKER,
      edgeKey: 'edge-key-value-24-chars-minimum!!',
    });
    expect(result).toEqual({ action: 'set', engaged: true });
    const put = requests.find((r) => r.method === 'PUT');
    expect(JSON.parse(put.body)).toEqual({
      name: 'INTERNAL_EDGE_KEY',
      text: 'edge-key-value-24-chars-minimum!!',
      type: 'secret_text',
    });
  });

  test('deletes a stale secret when the blob stopped naming the key', async () => {
    const secrets = ['ACTIVE_BACKEND', 'INTERNAL_EDGE_KEY'];
    installFetch(secrets);
    const result = await syncWorkerEdgeKey({
      accountId: ACCOUNT_ID,
      workerName: WORKER,
      edgeKey: '',
    });
    expect(result).toEqual({ action: 'deleted', engaged: false });
    expect(secrets).toEqual(['ACTIVE_BACKEND']);
  });

  test('is a no-op when the secret is already absent and the blob does not name it', async () => {
    const secrets = ['ACTIVE_BACKEND'];
    installFetch(secrets);
    const result = await syncWorkerEdgeKey({
      accountId: ACCOUNT_ID,
      workerName: WORKER,
      edgeKey: undefined,
    });
    expect(result).toEqual({ action: 'noop', engaged: false });
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  test('throws when Cloudflare refuses the sync', async () => {
    installFetch(['ACTIVE_BACKEND']);
    globalThis.fetch = async () =>
      Response.json({ success: false, errors: [{ message: 'forbidden' }] }, { status: 403 });
    await expect(
      syncWorkerEdgeKey({
        accountId: ACCOUNT_ID,
        workerName: WORKER,
        edgeKey: 'edge-key-value-24-chars-minimum!!',
      }),
    ).rejects.toThrow('failed');
  });
});

describe('verifyInternalEdgeEngagement', () => {
  test('accepts 404 bare + 401 with the key when engaged, the fail-closed answers when not', async () => {
    installFetch([], [404, 401]);
    await expect(
      verifyInternalEdgeEngagement({
        origin: ORIGIN,
        edgeKey: 'edge-key-value-24-chars-minimum!!',
      }),
    ).resolves.toEqual({ bareStatus: 404, matchedStatus: 401, engaged: true });
    const matched = requests.filter((r) => r.url === PROBE_URL);
    expect(matched).toHaveLength(2);
    expect(matched[1].method).toBe('POST');
    installFetch([], 401);
    await expect(verifyInternalEdgeEngagement({ origin: ORIGIN, edgeKey: '' })).resolves.toEqual({
      bareStatus: 401,
      engaged: false,
    });
    installFetch([], 503);
    await expect(
      verifyInternalEdgeEngagement({ origin: ORIGIN, edgeKey: undefined }),
    ).resolves.toEqual({ bareStatus: 503, engaged: false });
  });

  test('fails loudly when the edge gate is configured but not engaged', async () => {
    installFetch([], 401);
    await expect(
      verifyInternalEdgeEngagement({
        origin: ORIGIN,
        edgeKey: 'edge-key-value-24-chars-minimum!!',
      }),
    ).rejects.toThrow('edge gate is not engaged');
  });

  test('fails loudly when the Worker rejects the synced key (secret does not match the blob)', async () => {
    installFetch([], [404, 404]);
    await expect(
      verifyInternalEdgeEngagement({
        origin: ORIGIN,
        edgeKey: 'edge-key-value-24-chars-minimum!!',
      }),
    ).rejects.toThrow('does not match the env blob');
  });

  test('fails loudly when the control plane answers keyless in any other way', async () => {
    installFetch([], 200);
    await expect(verifyInternalEdgeEngagement({ origin: ORIGIN, edgeKey: '' })).rejects.toThrow(
      'not fail-closed',
    );
    installFetch([], 404);
    await expect(verifyInternalEdgeEngagement({ origin: ORIGIN, edgeKey: '' })).rejects.toThrow(
      'not fail-closed',
    );
  });
});
