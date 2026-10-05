import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TeamsActivity } from '../channels/teams/types';

let apiCalls: Array<{ fn: string; args: unknown[] }> = [];
/** When set, Teams refuses any activity carrying an inline data: image — as it
 *  does when the base64 payload pushes the activity past its size cap. */
let refuseInlineImages = false;
mock.module('../channels/teams-api', () => ({
  sendActivity: async (...a: unknown[]) => {
    apiCalls.push({ fn: 'sendActivity', args: a });
    const activity = a[1] as { attachments?: Array<{ contentUrl?: string }> } | undefined;
    const inline = activity?.attachments?.some((x) => x.contentUrl?.startsWith('data:'));
    if (refuseInlineImages && inline) return null;
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

// The tenants the project's install proved (chat_installs), which the proxy
// mints Graph tokens for — never the admin-writable MS_TEAMS_TENANT_ID secret.
let provenTenants: string[] = ['tenant-1'];
mock.module('../channels/teams/inbound', () => ({
  provenTeamsTenants: async () => provenTenants,
}));

// How teams/post.ts `resolveTeamsProjectConversation` answers: the server's own
// address for a conversation bound to the project. The upload never uses a
// service URL from the caller.
let bound = true;
let storedServiceUrl = 'https://smba.trafficmanager.net/teams/';
let storedType: string | null = null;
let resolveCalls: Array<{ projectId: string; conversationId: string }> = [];
mock.module('../channels/teams/post', () => ({
  resolveTeamsProjectConversation: async (projectId: string, conversationId: string) => {
    resolveCalls.push({ projectId, conversationId });
    if (!bound) return { ok: false, error: 'This project has no such Teams conversation.', status: 404 };
    return {
      ok: true,
      ref: { serviceUrl: storedServiceUrl, conversationId, tenantId: 'tenant-1', projectId },
      conversationType: storedType,
    };
  },
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
  bound = true;
  storedServiceUrl = 'https://smba.trafficmanager.net/teams/';
  storedType = null;
  resolveCalls = [];
  refuseInlineImages = false;
  dbWrites = [];
  dbResults = [];
  fetchCalls = [];
  nextFetchOk = true;
  graphStatus = 200;
  channelOwnershipOk = true;
  provenTenants = ['tenant-1'];
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
    conversationId: 'conv-1',
    filename: 'r.pdf',
  };

  // F-7: the route took `service_url` from the request body, and the service
  // allowlist accepted `*.azurewebsites.net`, a namespace any Azure customer
  // can register — so a caller with connector-write could have the bot's
  // token sent to a host of their own, and post into any conversation the bot
  // reaches. The address is now the server's alone.
  test('the conversation is addressed at the service URL the server stored', async () => {
    const r = await initiateTeamsUpload('proj-1', { ...base, contentBase64: Buffer.from('hello').toString('base64') });
    expect(r.ok).toBe(true);
    expect(resolveCalls).toEqual([{ projectId: 'proj-1', conversationId: 'conv-1' }]);
    const ref = apiCalls[0]?.args[0] as { serviceUrl: string; tenantId?: string };
    expect(ref.serviceUrl).toBe('https://smba.trafficmanager.net/teams/');
    expect(ref.tenantId).toBe('tenant-1');
    const stashed = dbWrites.find((w) => w.op === 'insert.values')?.payload as { serviceUrl: string };
    expect(stashed.serviceUrl).toBe('https://smba.trafficmanager.net/teams/');
  });

  test('a conversation not bound to the project is refused 404 — nothing stored, nothing sent', async () => {
    bound = false;
    const r = await initiateTeamsUpload('proj-1', { ...base, contentBase64: Buffer.from('hello').toString('base64') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
    expect(apiCalls).toEqual([]);
  });

  test('a stored service URL outside the Bot Framework hosts is refused 409, never tokened', async () => {
    storedServiceUrl = 'https://attacker.azurewebsites.net/';
    const r = await initiateTeamsUpload('proj-1', { ...base, contentBase64: Buffer.from('hello').toString('base64') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(apiCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  test('the binding decides where the file goes, not the caller', async () => {
    storedType = 'personal';
    const r = await initiateTeamsUpload('proj-1', {
      ...base,
      conversationType: 'channel',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    expect(r).toMatchObject({ ok: true, delivered: 'consent_card' });
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
  const MANAGED = { kind: 'managed' } as const;
  const UPLOAD_URL = 'https://example-my.sharepoint.com/personal/upload/slot';
  const pendingRow = (over: Record<string, unknown> = {}) => ({
    uploadId: 'u1',
    projectId: 'proj-1',
    filename: 'r.pdf',
    contentBase64: Buffer.from('hi').toString('base64'),
    conversationId: 'conv-1',
    ...over,
  });
  const accept = (over: { conversationId?: string; uploadUrl?: string } = {}) =>
    ({
      type: 'invoke',
      conversation: { id: over.conversationId ?? 'conv-1' },
      value: {
        action: 'accept',
        context: { uploadId: 'u1' },
        uploadInfo: { uploadUrl: over.uploadUrl ?? UPLOAD_URL, contentUrl: 'https://sp/r.pdf', name: 'r.pdf' },
      },
    }) as TeamsActivity;

  test('decline deletes the pending upload, no PUT', async () => {
    await handleFileConsentInvoke({
      type: 'invoke',
      value: { action: 'decline', context: { uploadId: 'u1' } },
    } as TeamsActivity, MANAGED);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
    expect(fetchCalls.some((f) => f.method === 'PUT')).toBe(false);
  });

  test('accept loads the row, PUTs the bytes, posts a file-info card, deletes the row', async () => {
    dbResults = [[pendingRow()]];
    await handleFileConsentInvoke(accept(), MANAGED);
    expect(fetchCalls.some((f) => f.method === 'PUT' && f.url === UPLOAD_URL)).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['sendActivity']);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
  });

  test('an answer from another conversation leaves the upload alone', async () => {
    dbResults = [[pendingRow()]];
    await handleFileConsentInvoke(accept({ conversationId: 'conv-other' }), MANAGED);
    expect(fetchCalls.some((f) => f.method === 'PUT')).toBe(false);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(false);
    expect(apiCalls).toEqual([]);
  });

  test("a bring-your-own bot cannot answer another project's upload", async () => {
    dbResults = [[pendingRow({ projectId: 'proj-other' })]];
    await handleFileConsentInvoke(accept(), { kind: 'project', projectId: 'proj-1', tenantId: 'tenant-1' });
    expect(fetchCalls.some((f) => f.method === 'PUT')).toBe(false);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(false);
  });

  test('the file is PUT only to a Microsoft 365 upload URL', async () => {
    dbResults = [[pendingRow()]];
    await handleFileConsentInvoke(accept({ uploadUrl: 'https://collector.example.test/slot' }), MANAGED);
    expect(fetchCalls.some((f) => f.method === 'PUT')).toBe(false);
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
      conversationId: 'a:1SyntheticPersonalChat_00000000000',
      conversationType: 'channel',
      teamGroupId: 'group-1',
      filename: 'report.pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});


// An agent's image in a PERSONAL chat used to go through the consent card —
// "Kortix wants to send you chart.png — Accept / Decline", then OneDrive — the
// worst image experience of the three scopes, in the most common one. A group
// chat or channel posted inline with NO fallback: a refused post was a 502.
describe('initiateTeamsUpload — an image is shown inline first, in every scope', () => {
  const png = Buffer.from('fake-png-bytes').toString('base64');
  const base = {
    conversationId: 'conv-1',
    filename: 'chart.png',
    contentBase64: png,
  };
  const inlinePosts = () =>
    apiCalls.filter((c) =>
      (c.args[1] as { attachments?: Array<{ contentUrl?: string }> })?.attachments?.some((x) =>
        x.contentUrl?.startsWith('data:image/png;base64,'),
      ),
    );
  const consentPosts = () =>
    apiCalls.filter((c) =>
      (c.args[1] as { attachments?: Array<{ contentType?: string }> })?.attachments?.some(
        (x) => x.contentType === 'application/vnd.microsoft.teams.card.file.consent',
      ),
    );

  test('a personal-chat image is shown inline, with no consent card and no pending upload', async () => {
    const r = await initiateTeamsUpload('proj-1', { ...base, conversationType: 'personal' });

    expect(r).toEqual({ ok: true, delivered: 'inline' });
    expect(inlinePosts()).toHaveLength(1);
    expect(consentPosts()).toHaveLength(0);
    expect(dbWrites.some((w) => w.op === 'insert.values')).toBe(false);
  });

  test('a personal-chat image Teams refuses inline falls back to the consent card', async () => {
    refuseInlineImages = true;
    const r = await initiateTeamsUpload('proj-1', { ...base, conversationType: 'personal' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.delivered).toBe('consent_card');
    expect(inlinePosts()).toHaveLength(1);
    expect(consentPosts()).toHaveLength(1);
  });

  test('a group-chat image Teams refuses says WHY, instead of a bare 502', async () => {
    // A group chat cannot take a file transfer, so there is no fallback left —
    // but "send it inline" would be circular: that is what just failed.
    refuseInlineImages = true;
    const r = await initiateTeamsUpload('proj-1', { ...base, conversationType: 'groupChat' });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain('too large for Teams to show inline');
      expect(r.error).not.toContain('send images inline');
    }
  });

  test('a group-chat image that fits is still shown inline', async () => {
    const r = await initiateTeamsUpload('proj-1', { ...base, conversationType: 'groupChat' });
    expect(r).toEqual({ ok: true, delivered: 'inline' });
  });

  test('a NON-image file in a personal chat goes straight to the consent card', async () => {
    const r = await initiateTeamsUpload('proj-1', {
      ...base,
      filename: 'report.pdf',
      conversationType: 'personal',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.delivered).toBe('consent_card');
    expect(inlinePosts()).toHaveLength(0);
  });
});

/**
 * The download proxy attaches an app-only Graph token for the tenant, so a
 * caller-chosen Graph path would read whatever the app's permissions reach.
 * Only the message hosted-content (inline image) paths an activity carries are
 * accepted. And the bot connector token goes only to the Teams connector's own
 * Traffic Manager profile — any Azure customer can name another one.
 */
describe('download proxy — Graph paths and attachment hosts', () => {
  const HOSTED_CHAT =
    'https://graph.microsoft.com/v1.0/chats/19:abc@thread.v2/messages/1712345678901/hostedContents/aWQ9eF8wLXd1cy1kMTAt/$value';
  const HOSTED_CHANNEL =
    'https://graph.microsoft.com/v1.0/teams/group-1/channels/19:chan@thread.tacv2/messages/171/replies/172/hostedContents/aWQ9/$value';

  test('a message hosted-content URL is fetched with the Graph token', async () => {
    for (const url of [HOSTED_CHAT, HOSTED_CHANNEL]) {
      fetchCalls = [];
      await downloadTeamsFile('proj-1', url).catch(() => null);
      // The fetch mock answers `/channels/` GETs as the ownership probe, so
      // assert on the outgoing request, not the parsed body.
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(url);
      expect(fetchCalls[0].headers?.Authorization).toBe('Bearer graph-tok');
    }
  });

  test('any other Graph path is refused 400 and never fetched', async () => {
    for (const url of [
      'https://graph.microsoft.com/v1.0/users',
      'https://graph.microsoft.com/v1.0/sites/root/drive/root/children',
      'https://graph.microsoft.com/v1.0/drives/d1/items/i1/content',
      `${HOSTED_CHAT}?$select=id`,
      'https://graph.microsoft.com/v1.0/chats/19:abc/messages/1/hostedContents/x%2F..%2F..%2Fusers/$value',
      'https://graph.microsoft.com/v1.0/chats/a/messages/b/hostedContents/c/$value/extra',
    ]) {
      fetchCalls = [];
      const r = await downloadTeamsFile('proj-1', url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
      expect(fetchCalls).toHaveLength(0);
    }
  });

  test('a hosted-content URL with no proven tenant is 404, with no token minted', async () => {
    provenTenants = [];
    const r = await downloadTeamsFile('proj-1', HOSTED_CHAT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });

  test('another Traffic Manager profile is refused outright — never fetched, never tokened', async () => {
    const r = await downloadTeamsFile('proj-1', 'https://attacker-profile.trafficmanager.net/v3/attachments/1/views/original');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });
});

