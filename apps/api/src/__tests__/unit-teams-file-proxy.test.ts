import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let apiCalls: Array<{ fn: string; args: unknown[] }> = [];
mock.module('../channels/teams-api', () => ({
  sendActivity: async (...a: unknown[]) => {
    apiCalls.push({ fn: 'sendActivity', args: a });
    return 'posted-1';
  },
  sendCard: async () => 'card-1',
  updateCard: async () => true,
  sendTyping: async () => {},
  sendText: async () => 'text-1',
  updateActivity: async () => true,
  cardActivity: (c: unknown) => ({ type: 'message', attachments: [{ contentType: 'x', content: c }] }),
}));
mock.module('../channels/teams-auth', () => ({ graphToken: async () => 'graph-tok' }));
mock.module('../channels/install-store', () => ({
  loadTeamsTenantForProject: async () => 'tenant-1',
  saveTeamsServiceUrl: async () => {},
}));

let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];
function makeChain(op: string): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'returning']) chain[m] = () => chain;
  chain.values = (payload: unknown) => {
    dbWrites.push({ op: `${op}.values`, payload });
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  chain.catch = () => chain;
  chain.finally = () => chain;
  return chain;
}
mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
    delete: () => {
      dbWrites.push({ op: 'delete' });
      return makeChain('delete');
    },
  },
  hasDatabase: () => true,
}));

const { downloadTeamsFile, initiateTeamsUpload, handleFileConsentInvoke } = await import('../channels/teams/file-proxy');

let fetchCalls: Array<{ url: string; method: string }> = [];
let nextFetchOk = true;
const realFetch = globalThis.fetch;
beforeEach(() => {
  apiCalls = [];
  dbWrites = [];
  dbResults = [];
  fetchCalls = [];
  nextFetchOk = true;
  globalThis.fetch = (async (url: string, init: { method?: string }) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
    return { ok: nextFetchOk, status: nextFetchOk ? 200 : 502, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => 'application/pdf' } };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('downloadTeamsFile', () => {
  test('rejects a non-Microsoft host (SSRF guard)', async () => {
    const r = await downloadTeamsFile('proj-1', 'https://evil.example.com/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });
  test('fetches an allowed SharePoint host', async () => {
    const r = await downloadTeamsFile('proj-1', 'https://contoso.sharepoint.com/f/report.pdf');
    expect(r.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('initiateTeamsUpload', () => {
  const base = { serviceUrl: 'https://smba/', conversationId: 'conv-1', filename: 'r.pdf' };

  test('rejects an oversize file before touching the DB', async () => {
    const big = 'A'.repeat(6 * 1024 * 1024);
    const r = await initiateTeamsUpload('proj-1', { ...base, contentBase64: big });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
  });

  test('stashes the file and posts a consent card', async () => {
    const r = await initiateTeamsUpload('proj-1', { ...base, contentBase64: Buffer.from('hello').toString('base64') });
    expect(r.ok).toBe(true);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['sendActivity']);
  });
});

describe('handleFileConsentInvoke', () => {
  test('decline deletes the pending upload, no PUT', async () => {
    await handleFileConsentInvoke({ type: 'invoke', value: { action: 'decline', context: { uploadId: 'u1' } } } as any);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
    expect(fetchCalls.some((f) => f.method === 'PUT')).toBe(false);
  });

  test('accept loads the row, PUTs the bytes, posts a file-info card, deletes the row', async () => {
    dbResults = [[{ uploadId: 'u1', filename: 'r.pdf', contentBase64: Buffer.from('hi').toString('base64'), serviceUrl: 'https://smba/', conversationId: 'conv-1' }]];
    await handleFileConsentInvoke({
      type: 'invoke',
      serviceUrl: 'https://smba/',
      conversation: { id: 'conv-1' },
      value: { action: 'accept', context: { uploadId: 'u1' }, uploadInfo: { uploadUrl: 'https://upload/slot', contentUrl: 'https://sp/r.pdf', name: 'r.pdf' } },
    } as any);
    expect(fetchCalls.some((f) => f.method === 'PUT' && f.url === 'https://upload/slot')).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['sendActivity']);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
  });
});
