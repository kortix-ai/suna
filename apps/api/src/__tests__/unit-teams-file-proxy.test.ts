import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TeamsActivity } from '../channels/teams/types';

let apiCalls: Array<{ fn: string; args: unknown[] }> = [];
mock.module('../channels/teams-api', () => ({
  sendActivity: async (...a: unknown[]) => {
    apiCalls.push({ fn: 'sendActivity', args: a });
    return 'posted-1';
  },
  sendCard: async (...a: unknown[]) => {
    apiCalls.push({ fn: 'sendCard', args: a });
    return 'card-1';
  },
  updateCard: async () => true,
  sendTyping: async () => {},
  sendText: async () => 'text-1',
  updateActivity: async () => true,
  cardActivity: (c: unknown) => ({
    type: 'message',
    attachments: [{ contentType: 'x', content: c }],
  }),
}));
mock.module('../channels/teams-auth', () => ({
  graphToken: async () => 'graph-tok',
  botConnectorToken: async () => 'bot-tok',
  teamsChannelEnabled: () => true,
  teamsConfigured: () => true,
}));
mock.module('../channels/install-store', () => ({
  loadTeamsBotCredentials: async () => ({ appId: 'app-1', appPassword: 'secret' }),
  loadTeamsTenantForProject: async () => 'tenant-1',
  saveTeamsServiceUrl: async () => {},
}));

let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];

type DbChain = Promise<unknown[]> & {
  from: () => DbChain;
  where: () => DbChain;
  limit: () => DbChain;
  returning: () => DbChain;
  values: (payload: unknown) => DbChain;
};

function makeChain(op: string): DbChain {
  const chain = Promise.resolve(dbResults.shift() ?? []) as DbChain;
  for (const method of ['from', 'where', 'limit', 'returning'] as const) {
    chain[method] = () => chain;
  }
  chain.values = (payload: unknown) => {
    dbWrites.push({ op: `${op}.values`, payload });
    return chain;
  };
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

const { downloadTeamsFile, initiateTeamsUpload, handleFileConsentInvoke } = await import(
  '../channels/teams/file-proxy'
);

let fetchCalls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
let graphStatus = 200;
let channelOwnershipOk = true;
let nextFetchOk = true;
const realFetch = globalThis.fetch;
beforeEach(() => {
  apiCalls = [];
  dbWrites = [];
  dbResults = [];
  fetchCalls = [];
  nextFetchOk = true;
  graphStatus = 200;
  channelOwnershipOk = true;
  globalThis.fetch = (async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers });
    const u = String(url);
    if (u.startsWith('https://graph.microsoft.com/')) {
      if (u.includes('/channels/') && (init?.method ?? 'GET') === 'GET') {
        return { ok: channelOwnershipOk, status: channelOwnershipOk ? 200 : 404, json: async () => ({ id: 'ch' }), text: async () => '' };
      }
      if (graphStatus !== 200) {
        return { ok: false, status: graphStatus, text: async () => '{"error":{"code":"accessDenied"}}', json: async () => ({}) };
      }
      if (init?.method === 'PUT') {
        return { ok: true, status: 201, json: async () => ({ id: 'item-1', webUrl: 'https://kortixssotest.sharepoint.com/sites/x/report.pdf', parentReference: { driveId: 'drive-1' } }), text: async () => '' };
      }
      if (u.endsWith('/createLink')) {
        return { ok: true, status: 201, json: async () => ({ link: { webUrl: 'https://kortixssotest.sharepoint.com/:b:/s/x/link' } }), text: async () => '' };
      }
    }
    return {
      ok: nextFetchOk,
      status: nextFetchOk ? 200 : 502,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: { get: () => 'application/pdf' },
    };
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

  test('a Bot Framework attachment URL (pasted image) is fetched with the bot connector token', async () => {
    const r = await downloadTeamsFile(
      'proj-1',
      'https://smba.trafficmanager.net/emea/36009a52/v3/attachments/0-abc/views/original',
    );
    expect(r.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].headers?.Authorization).toBe('Bearer bot-tok');
  });
});

describe('initiateTeamsUpload', () => {
  const base = {
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    conversationId: 'conv-1',
    filename: 'r.pdf',
  };

  test('rejects a non-Microsoft serviceUrl before touching the DB (F-7)', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      ...base,
      serviceUrl: 'https://attacker.example.com/v3/conversations/x/activities',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
    expect(apiCalls.map((c) => c.fn)).toEqual([]);
  });

  test('rejects an oversize file before touching the DB', async () => {
    const big = 'A'.repeat(6 * 1024 * 1024);
    const r = await initiateTeamsUpload('proj-1', { ...base, contentBase64: big });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
  });

  test('stashes the file and posts a consent card', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      ...base,
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    expect(r.ok).toBe(true);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['sendActivity']);
  });
});

describe('handleFileConsentInvoke', () => {
  test('decline deletes the pending upload, no PUT', async () => {
    await handleFileConsentInvoke({
      type: 'invoke',
      value: { action: 'decline', context: { uploadId: 'u1' } },
    } as TeamsActivity);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
    expect(fetchCalls.some((f) => f.method === 'PUT')).toBe(false);
  });

  test('accept loads the row, PUTs the bytes, posts a file-info card, deletes the row', async () => {
    dbResults = [
      [
        {
          uploadId: 'u1',
          filename: 'r.pdf',
          contentBase64: Buffer.from('hi').toString('base64'),
          serviceUrl: 'https://smba.trafficmanager.net/teams/',
          conversationId: 'conv-1',
        },
      ],
    ];
    await handleFileConsentInvoke({
      type: 'invoke',
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      conversation: { id: 'conv-1' },
      value: {
        action: 'accept',
        context: { uploadId: 'u1' },
        uploadInfo: {
          uploadUrl: 'https://upload/slot',
          contentUrl: 'https://sp/r.pdf',
          name: 'r.pdf',
        },
      },
    } as TeamsActivity);
    expect(fetchCalls.some((f) => f.method === 'PUT' && f.url === 'https://upload/slot')).toBe(
      true,
    );
    expect(apiCalls.map((c) => c.fn)).toEqual(['sendActivity']);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
  });
});

/**
 * Teams accepts the file-consent card in PERSONAL chats only. In a channel or
 * group chat the bot has two other ways: an image goes inline (base64 data
 * URI attachment, any scope), anything else is uploaded to the team's
 * SharePoint drive through Graph and shared as a link card.
 */
describe('initiateTeamsUpload outside a personal chat', () => {
  const channel = {
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    conversationId: '19:chan@thread.tacv2;messageid=1',
    conversationType: 'channel' as const,
  };

  test('an image in a channel is sent inline, no consent card, nothing stashed', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      ...channel,
      filename: 'chart.png',
      contentBase64: Buffer.from('png-bytes').toString('base64'),
      description: 'Here is the chart',
    });
    expect(r).toMatchObject({ ok: true, delivered: 'inline' });
    expect(dbWrites.filter((w) => w.op === 'insert')).toHaveLength(0);
    const sent = apiCalls.find((c) => c.fn === 'sendActivity')?.args[1] as {
      text?: string;
      attachments: Array<{ contentType: string; contentUrl?: string; name?: string }>;
    };
    expect(sent.text).toBe('Here is the chart');
    expect(sent.attachments[0]).toMatchObject({ contentType: 'image/png', name: 'chart.png' });
    expect(sent.attachments[0].contentUrl).toMatch(/^data:image\/png;base64,/);
  });

  test('a document in a channel is uploaded to the team drive and shared as a link', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      ...channel,
      teamGroupId: 'group-1',
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    expect(r).toMatchObject({ ok: true, delivered: 'drive_link' });
    const put = fetchCalls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('https://graph.microsoft.com/v1.0/groups/group-1/drive/root:/Kortix/report.pdf:/content');
    expect(put?.headers?.Authorization).toBe('Bearer graph-tok');
    const link = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/createLink'));
    expect(link).toBeDefined();
    const sent = apiCalls.find((c) => c.fn === 'sendCard')?.args[1];
    expect(JSON.stringify(sent)).toContain('https://kortixssotest.sharepoint.com/:b:/s/x/link');
    expect(JSON.stringify(sent)).toContain('report.pdf');
  });

  test('a document in a channel with no team drive available is refused with a reason the agent can relay', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      ...channel,
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/personal chat|team/i);
    }
  });

  test('Graph refusing the upload (missing Files.ReadWrite.All) is a 502 naming the permission', async () => {
    graphStatus = 403;
    const r = await initiateTeamsUpload('proj-1', {
      ...channel,
      teamGroupId: 'group-1',
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.error).toContain('Files.ReadWrite.All');
    }
  });
});

/**
 * Security review on #7395 (Strix), both HIGH:
 * - CWE-918: the download proxy attached the bot connector token to any host
 *   the broad outbound allowlist accepted — including the customer-registrable
 *   `*.azurewebsites.net` namespace, so a caller could capture the token.
 * - CWE-862: the team-drive upload trusted a client-supplied `team_group_id`,
 *   so connector-write on one project could write into ANY team's SharePoint
 *   drive in the tenant.
 */
describe('file proxy — token and drive authorization', () => {
  test('an azurewebsites.net url is refused outright — never fetched, never tokened', async () => {
    const r = await downloadTeamsFile('proj-1', 'https://attacker.azurewebsites.net/steal');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  test('a real Bot Framework attachment host still gets the token', async () => {
    const r = await downloadTeamsFile('proj-1', 'https://smba.trafficmanager.net/emea/x/v3/attachments/1/views/original');
    expect(r.ok).toBe(true);
    expect(fetchCalls[0].headers?.Authorization).toBe('Bearer bot-tok');
  });

  test('a SharePoint url is fetched with NO bot token', async () => {
    const r = await downloadTeamsFile('proj-1', 'https://contoso.sharepoint.com/f/report.pdf');
    expect(r.ok).toBe(true);
    expect(fetchCalls[0].headers?.Authorization).toBeUndefined();
  });

  test('uploading to a team that does not own the conversation is refused 403, with no write', async () => {
    channelOwnershipOk = false;
    const r = await initiateTeamsUpload('proj-1', {
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversationId: '19:chan@thread.tacv2;messageid=1',
      conversationType: 'channel',
      teamGroupId: 'someone-elses-group',
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toMatch(/does not own this conversation/);
    }
    expect(fetchCalls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('the ownership check asks Graph for the channel under that team, stripping the messageid suffix', async () => {
    await initiateTeamsUpload('proj-1', {
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversationId: '19:chan@thread.tacv2;messageid=1',
      conversationType: 'channel',
      teamGroupId: 'group-1',
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    const check = fetchCalls.find((c) => c.url.includes('/channels/') && c.method === 'GET');
    expect(check?.url).toBe(
      'https://graph.microsoft.com/v1.0/teams/group-1/channels/19%3Achan%40thread.tacv2',
    );
  });

  test('a non-channel conversation id can never select a drive', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversationId: 'a:1FQyR2jW1pEUK',
      conversationType: 'channel',
      teamGroupId: 'group-1',
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});
