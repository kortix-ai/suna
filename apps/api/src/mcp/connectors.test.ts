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
