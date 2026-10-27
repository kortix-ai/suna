import { describe, expect, test } from 'bun:test';
import { CONNECTOR_TOOLS, type Host, denialNext, fitData, runConnectorTool, searchActions, splitTool } from './connectors';

const catalog = [
  {
    slug: 'gmail',
    name: 'Gmail',
    provider: 'composio',
    status: 'active',
    actions: [
      { path: 'send_email', description: 'Send an email\nto someone', risk: 'write' },
      { path: 'threads.list', description: 'List mail threads', risk: 'read' },
    ],
  },
  { slug: 'slack', name: 'Slack', provider: 'composio', status: 'active', actions: [{ path: 'post', description: 'Post a message to a channel', risk: 'write' }] },
];

describe('splitTool', () => {
  test('splits at the first dot; the action may contain dots', () => {
    expect(splitTool('gmail.threads.list')).toEqual({ connector: 'gmail', action: 'threads.list' });
  });
  test.each(['gmail', '.x', 'gmail.', ''])('%p is not a tool id', (t) => expect(splitTool(t)).toBeNull());
});

describe('searchActions', () => {
  test('whole phrase first, then every-word matches; one-line descriptions; no schema', () => {
    const r = searchActions(catalog, 'email send', 20);
    expect(r.total).toBe(1);
    expect(r.matches[0]).toEqual({ tool: 'gmail.send_email', risk: 'write', description: 'Send an email to someone' });
    const phrase = searchActions(catalog, 'mail threads', 20);
    expect(phrase.matches.map((m: any) => m.tool)).toEqual(['gmail.threads.list']);
  });
  test('empty query lists from the top and limit cuts with the total kept', () => {
    const r = searchActions(catalog, '', 2);
    expect(r.matches).toHaveLength(2);
    expect(r.total).toBe(3);
  });
});

describe('fitData', () => {
  test('small data stays inline', () => {
    expect(JSON.parse(fitData({ ok: true }, 'data', { a: 1 }))).toEqual({ ok: true, data: { a: 1 } });
  });
  test('big data becomes a marked preview and the reply stays valid JSON', () => {
    const out = JSON.parse(fitData({ ok: true, account: { label: 'x' } }, 'data', { rows: 'y'.repeat(500) }, 100));
    expect(out.data_truncated).toBe(true);
    expect(out.data_chars).toBeGreaterThan(500);
    expect(out.data_preview).toHaveLength(100);
    expect(out.account.label).toBe('x');
    expect(out.data).toBeUndefined();
  });
});

describe('denialNext', () => {
  test('policy_block says do not retry; account errors say what to pass', () => {
    expect(denialNext('policy_block', {})).toContain('Do not retry');
    expect(denialNext('account_required', {})).toContain('account');
    expect(denialNext('connector_not_connected', {})).toContain('connect_connector');
    expect(denialNext('connector_not_connected', { available_accounts: ['A'] })).toContain('available_accounts');
    expect(denialNext('something_else', {})).toBeUndefined();
  });
});

test('every connector tool is titled, described, strict, and names project_id', () => {
  for (const t of CONNECTOR_TOOLS) {
    expect(t.title.length).toBeGreaterThan(3);
    expect(t.description.length).toBeGreaterThan(80);
    expect(t.inputSchema.additionalProperties).toBe(false);
    expect(t.inputSchema.required).toContain('project_id');
  }
});

describe('call_connector', () => {
  test('a big result is fitted once: `output` (the unwrapped payload) never rides beside the preview', async () => {
    const rows = 'y'.repeat(50_000);
    const host = {
      projectId: () => 'proj-1',
      arg: (input: Record<string, unknown>, key: string) => String(input[key]),
      optionalArg: () => undefined,
      input: (message: string) => new Error(message),
      text: (value: string, isError?: boolean) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }),
      call: async () => ({
        status: 200,
        body: JSON.stringify({ ok: true, data: { provider: 'composio', result: { rows } }, output: { rows }, binding: 'composio', upstream_status: 200 }),
      }),
    } as unknown as Host;
    const result = (await runConnectorTool('call_connector', { tool: 'gmail.fetch_emails', args: {} }, host)) as {
      content: Array<{ text: string }>;
    };
    const text = result.content[0]!.text;
    const reply = JSON.parse(text);
    expect(reply.data_truncated).toBe(true);
    expect(reply.output).toBeUndefined();
    expect(reply.binding).toBe('composio');
    expect(text.length).toBeLessThan(45_000);
  });
});

test('call_connector: a tool_error is a failed tool result with the tool\'s text and what to do', async () => {
  const host = {
    projectId: () => 'proj-1',
    arg: (input: Record<string, unknown>, key: string) => String(input[key]),
    optionalArg: () => undefined,
    input: (message: string) => new Error(message),
    text: (value: string, isError?: boolean) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }),
    call: async () => ({
      status: 200,
      body: JSON.stringify({ ok: false, status: 'tool_error', error: 'no such issue', upstream_error: 'no such issue', data: { jsonrpc: '2.0' }, binding: 'mcp', upstream_status: 200 }),
    }),
  } as unknown as Host;
  const result = (await runConnectorTool('call_connector', { tool: 'linear.get_issue', args: {} }, host)) as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.isError).toBe(true);
  const reply = JSON.parse(result.content[0]!.text);
  expect(reply).toMatchObject({ ok: false, status: 'tool_error', error: 'no such issue', data: { jsonrpc: '2.0' } });
  expect(reply.next).toContain('Fix the args');
});

describe('connector apps come from the one catalogue', () => {
  /** A host that records every API call. */
  function v2Host(calls: Array<{ method: string; path: string; query?: unknown; body?: unknown }>) {
    return {
      projectId: () => 'proj-1',
      arg: (input: Record<string, unknown>, key: string) => String(input[key]),
      optionalArg: (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined),
      input: (message: string) => new Error(message),
      apiResult: (reply: { status: number; body: string }) => ({ content: [{ type: 'text', text: reply.body }], isError: true }),
      text: (value: string, isError?: boolean) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }),
      call: async (method: string, path: string, opts: { query?: unknown; body?: unknown } = {}) => {
        calls.push({ method, path, ...opts });
        if (path.endsWith('/discover/connectors')) {
          return { status: 200, body: JSON.stringify({ items: [{ id: 'kortix:linear', kind: 'mcp', slug: 'linear', name: 'Linear', description: 'Issues.', categories: ['productivity'], mcpUrl: 'https://mcp.linear.app/mcp', oneClick: true }], nextCursor: undefined }) };
        }
        if (path.endsWith('/discover/connectors/detail')) {
          const id = (opts.query as { id: string }).id;
          if (id !== 'kortix:stripe') return { status: 404, body: JSON.stringify({ error: 'Connector not found' }) };
          return { status: 200, body: JSON.stringify({ item: { id, kind: 'mcp', slug: 'stripe', name: 'Stripe', description: 'Payments.' }, variants: [
            { id: 'kortix:stripe:mcp', kind: 'mcp', name: 'Stripe', url: 'https://mcp.stripe.com', connector: { provider: 'mcp' }, oneClick: true, recommended: true },
            { id: 'composio:stripe', kind: 'composio', name: 'Stripe', url: null, connector: null, oneClick: true },
            { id: 'stripe-docs', kind: 'http', name: 'Stripe docs', url: 'https://docs.stripe.com', connector: null },
          ] }) };
        }
        if (path.endsWith('/discover/connectors/tools')) {
          const way = (opts.query as { way?: string }).way;
          if (way === 'nope') return { status: 404, body: JSON.stringify({ error: 'no way' }) };
          return { status: 200, body: JSON.stringify({ way: { id: way ?? 'kortix:stripe:mcp', kind: way ? 'composio' : 'mcp', name: 'Stripe' }, tools: [{ name: 'list_customers', description: 'List customers' }], total: 23, source: 'directory' }) };
        }
        if (path.endsWith('/discover/install')) {
          const body = opts.body as { id: string; way?: string; name?: string };
          if (body.id === 'kortix:missing') return { status: 404, body: JSON.stringify({ error: 'Connector not found' }) };
          if (body.id === 'kortix:wiki' && (body as { as_new_profile?: boolean }).as_new_profile !== true) {
            return { status: 200, body: JSON.stringify({ ok: true, existing: true, slug: 'wiki', name: 'Wiki', way: { kind: 'mcp' }, next: 'ready' }) };
          }
          if (body.id === 'kortix:broken') {
            return { status: 200, body: JSON.stringify({ ok: true, existing: false, slug: 'broken', way: { kind: 'mcp' }, next: 'fix', error: 'tools/list returned 500' }) };
          }
          const managed = body.way === 'composio:linear' || body.id === 'composio:gmail';
          const slug = body.name ? body.name.toLowerCase() : body.id.split(':')[1];
          return { status: 200, body: JSON.stringify({ ok: true, slug, name: body.name ?? slug, provider: managed ? 'composio' : 'mcp', way: { kind: managed ? 'composio' : 'mcp' }, sync: { synced: 1 }, next: 'connect' }) };
        }
        if (method === 'POST' && path.endsWith('/connectors')) {
          return { status: 403, body: JSON.stringify({ error: 'An agent cannot add the custom server', code: 'custom_connector_needs_human', setup_url: 'https://app.test/setup' }) };
        }
        if (path.endsWith('/connectors/linear/accounts')) {
          return { status: 200, body: JSON.stringify({ accounts: [{ connection_id: 'c1', label: 'work', owner_type: 'project', is_default: true, connected_as: 'ops@example.test' }], default_account: 'work' }) };
        }
        return { status: 201, body: JSON.stringify({ sync: { synced: 1 } }) };
      },
    } as unknown as Host;
  }

  test('add_connector answers the existing profile of a way; as_new_profile adds another', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const again = JSON.parse(((await runConnectorTool('add_connector', { project_id: 'proj-1', app: 'wiki' }, v2Host(calls))) as { content: Array<{ text: string }> }).content[0]!.text);
    expect(again).toMatchObject({ connector: 'wiki', existing: true });
    expect(again.next).toContain('already');
    await runConnectorTool('add_connector', { project_id: 'proj-1', app: 'wiki', as_new_profile: true }, v2Host(calls));
    expect(calls.filter((c) => c.path.endsWith('/discover/install')).at(-1)?.body).toMatchObject({ id: 'kortix:wiki', as_new_profile: true });
  });

  test('add_connector reports an install whose tools did not load, and a custom server a person must add', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const broken = (await runConnectorTool('add_connector', { project_id: 'proj-1', app: 'broken' }, v2Host(calls))) as { content: Array<{ text: string }>; isError?: boolean };
    expect(JSON.parse(broken.content[0]!.text)).toMatchObject({ connector: 'broken', error: 'tools/list returned 500' });
    const custom = (await runConnectorTool('add_connector', { project_id: 'proj-1', provider: 'mcp', slug: 'evil', url: 'https://mcp.example.com' }, v2Host(calls))) as { content: Array<{ text: string }>; isError?: boolean };
    expect(custom.isError).toBe(true);
    const body = JSON.parse(custom.content[0]!.text);
    expect(body).toMatchObject({ code: 'custom_connector_needs_human', setup_url: 'https://app.test/setup' });
    expect(body.next).toContain('setup_url');
  });

  test('list_connector_accounts lists the accounts a call may name', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const out = JSON.parse(((await runConnectorTool('list_connector_accounts', { project_id: 'proj-1', connector: 'linear' }, v2Host(calls))) as { content: Array<{ text: string }> }).content[0]!.text);
    expect(out).toEqual({
      connector: 'linear',
      accounts: [{ label: 'work', owner: 'shared', default: true, connected_as: 'ops@example.test', connection_id: 'c1' }],
      default_account: 'work',
    });
  });

  test('no tool description sends the agent to a raw API route', () => {
    for (const t of CONNECTOR_TOOLS) {
      expect(JSON.stringify(t)).not.toMatch(/call_api|\/v1\//);
    }
  });

  test('search_connector_apps searches the whole catalogue; kind and one_click filter it', async () => {
    const calls: Array<{ method: string; path: string; query?: unknown }> = [];
    const result = (await runConnectorTool('search_connector_apps', { project_id: 'proj-1', query: 'linear' }, v2Host(calls))) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text).apps).toEqual([
      { app: 'kortix:linear', name: 'Linear', description: 'Issues.', categories: ['productivity'], via: 'mcp', one_click: true, mcp_url: 'https://mcp.linear.app/mcp' },
    ]);
    expect(calls.find((c) => c.path.endsWith('/discover/connectors'))?.query).toMatchObject({ oneClick: undefined, kind: undefined });
    expect(calls.some((c) => c.path.includes('/connect/toolkits') || c.path === '/v1/projects/proj-1')).toBe(false);
    await runConnectorTool('search_connector_apps', { project_id: 'proj-1', query: 'linear', one_click: true, kind: 'mcp,composio', category: 'productivity' }, v2Host(calls));
    expect(calls.filter((c) => c.path.endsWith('/discover/connectors')).at(-1)?.query).toMatchObject({ oneClick: '1', kind: 'mcp,composio', category: 'productivity' });
  });

  test('add_connector installs the recommended way through the catalogue, a bare slug being a Kortix app', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const result = (await runConnectorTool('add_connector', { project_id: 'proj-1', app: 'linear' }, v2Host(calls))) as { content: Array<{ text: string }> };
    expect(calls.find((c) => c.path.endsWith('/discover/install'))?.body).toEqual({ id: 'kortix:linear', way: undefined, name: undefined, slug: undefined, as_new_profile: undefined });
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/connectors'))).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ connector: 'linear', via: 'mcp' });
  });

  test('get_connector_app lists every way, best first, and the tools of the recommended way or the one asked for', async () => {
    const calls: Array<{ method: string; path: string; query?: unknown }> = [];
    const out = (await runConnectorTool('get_connector_app', { project_id: 'proj-1', app: 'stripe' }, v2Host(calls))) as { content: Array<{ text: string }> };
    const reply = JSON.parse(out.content[0]!.text);
    expect(reply.ways).toEqual([
      { way: 'kortix:stripe:mcp', name: 'Stripe', via: 'mcp', one_click: true, recommended: true, installable: true, url: 'https://mcp.stripe.com' },
      { way: 'composio:stripe', name: 'Stripe', via: 'composio', one_click: true, recommended: false, installable: true, url: null },
      { way: 'stripe-docs', name: 'Stripe docs', via: 'http', one_click: false, recommended: false, installable: false, url: 'https://docs.stripe.com' },
    ]);
    expect(reply.tools).toEqual({ way: 'kortix:stripe:mcp', via: 'mcp', total: 23, source: 'directory', list: [{ name: 'list_customers', description: 'List customers' }] });
    expect(reply.installed).toEqual([]);
    const other = (await runConnectorTool('get_connector_app', { project_id: 'proj-1', app: 'kortix:stripe', way: 'composio:stripe' }, v2Host(calls))) as { content: Array<{ text: string }> };
    expect(JSON.parse(other.content[0]!.text).tools.via).toBe('composio');
    const bad = (await runConnectorTool('get_connector_app', { project_id: 'proj-1', app: 'kortix:stripe', way: 'nope' }, v2Host(calls))) as { content: Array<{ text: string }> };
    expect(JSON.parse(bad.content[0]!.text).tools).toEqual({ error: 'no way "nope"' });
    await expect(runConnectorTool('get_connector_app', { project_id: 'proj-1', app: 'missing' }, v2Host(calls))).rejects.toThrow('not in the app catalogue');
  });

  test('add_connector with a way and a name; an app the catalogue lacks is an input error', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const result = (await runConnectorTool('add_connector', { project_id: 'proj-1', app: 'kortix:linear', way: 'composio:linear', name: 'Tracker' }, v2Host(calls))) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ connector: 'tracker', via: 'composio' });
    expect(JSON.parse(result.content[0]!.text).next).toContain('connect_connector');
    await expect(runConnectorTool('add_connector', { project_id: 'proj-1', app: 'missing' }, v2Host(calls))).rejects.toThrow('not in the app catalogue');
  });
});

describe('list_connectors with one connector', () => {
  function host(setsStatus: number) {
    return {
      projectId: () => 'proj-1',
      arg: (input: Record<string, unknown>, key: string) => String(input[key]),
      optionalArg: (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined),
      input: (message: string) => new Error(message),
      apiResult: (reply: { status: number; body: string }) => ({ content: [{ type: 'text', text: reply.body }], isError: true }),
      text: (value: string) => ({ content: [{ type: 'text', text: value }] }),
      call: async (_method: string, path: string) => {
        const gmail = { ...catalog[0], accounts: [], policy_set: 'read_only' };
        if (path.endsWith('/catalog') || path.endsWith('/connectors')) return { status: 200, body: JSON.stringify({ connectors: [gmail] }) };
        if (path.endsWith('/accounts')) return { status: 200, body: JSON.stringify({ accounts: [], default_account: null }) };
        if (path.endsWith('/policy-sets')) {
          return setsStatus < 400
            ? { status: 200, body: JSON.stringify({ sets: [
                { name: 'read_only', description: 'Read and search, never send', policies: [], agents: ['support'] },
                { name: 'outreach', description: null, policies: [], agents: [] },
              ] }) }
            : { status: setsStatus, body: JSON.stringify({ error: 'forbidden' }) };
        }
        return { status: 404, body: '{}' };
      },
    } as unknown as Host;
  }
  const row = async (status: number) => {
    const result = (await runConnectorTool('list_connectors', { project_id: 'proj-1', connector: 'gmail' }, host(status))) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(result.content[0]!.text).connectors[0];
  };

  test("lists the profile's sets and the caller's own set", async () => {
    const gmail = await row(200);
    expect(gmail.policy_set).toBe('read_only');
    expect(gmail.policy_sets).toEqual([
      { name: 'read_only', description: 'Read and search, never send', agents: ['support'] },
      { name: 'outreach', description: null, agents: [] },
    ]);
  });

  test('a caller that may not read the sets still gets its own set', async () => {
    const gmail = await row(403);
    expect(gmail.policy_set).toBe('read_only');
    expect(gmail.policy_sets).toBeUndefined();
  });
});
