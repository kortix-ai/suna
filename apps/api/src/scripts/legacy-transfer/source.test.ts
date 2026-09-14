import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacySource, resolveSandbox } from './source';
import { Ledger, mappedId } from './ledger';

const ref = 'abcdefghijklmnopqrst';
function fake(responses: Response[], calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return response;
  }) as typeof fetch;
}
const json = (data: unknown) => Response.json(data);

describe('read-only migration source', () => {
  test('continues after server-capped short pages and uses keyset pagination', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new LegacySource(ref, 'secret', fake([json([{ id: 'a' }]), json([{ id: 'b' }]), json([])], calls));
    const ids: unknown[] = [];
    for await (const rows of client.rows('resources', 'id', { pageSize: 500 })) ids.push(...rows.map(r => r.id));
    expect(ids).toEqual(['a', 'b']);
    expect(new URL(calls[1]!.url).searchParams.get('id')).toBe('gt.a');
    expect(calls.every(c => c.init?.method === 'GET' && c.init.redirect === 'error')).toBe(true);
  });
  test('rejects repeated and unordered keys instead of reporting a complete export', async () => {
    const client = new LegacySource(ref, 'secret', fake([json([{ id: 'b' }, { id: 'a' }])]));
    expect(async () => { for await (const _ of client.rows('resources', 'id')) {} }).toThrow('Unordered or duplicate');
  });
  test('requires an exact Content-Range count', async () => {
    const client = new LegacySource(ref, 'secret', fake([new Response(null, { status: 206, headers: { 'content-range': '0-999/16068' } }), new Response(null)]));
    expect(await client.count('threads')).toBe(16068);
    await expect(client.count('threads')).rejects.toThrow('Missing exact count');
  });
  test('redacts upstream error bodies', async () => {
    const client = new LegacySource(ref, 'secret', fake([new Response('credential=VERY_SECRET', { status: 401 })]));
    try { await client.count('threads'); throw new Error('Expected rejection'); }
    catch (error) { expect((error as Error).message).toBe('HEAD /rest/v1/threads: HTTP 401'); }
  });
  test('does not send a PAT to the Data API or accept an arbitrary host', () => {
    expect(() => new LegacySource(ref, 'sbp_secret')).toThrow('PAT');
    expect(() => new LegacySource('attacker.example', 'secret')).toThrow('project ref');
  });
  test('does not allow filters to override pagination', async () => {
    const client = new LegacySource(ref, 'secret', fake([]));
    expect(async () => { for await (const _ of client.rows('resources', 'id', { filters: { limit: '1' } })) {} }).toThrow('override pagination');
  });
  test('lists nested Storage objects without a delimiter and checks cursors', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new LegacySource(ref, 'secret', fake([
      json({ objects: [{ name: 'nested/a' }], hasNext: true, nextCursor: 'c' }),
      json({ objects: [{ name: 'nested/b' }], hasNext: false }),
    ], calls));
    let count = 0; for await (const rows of client.objects('file-uploads')) count += rows.length;
    expect(count).toBe(2);
    expect(JSON.parse(calls[0]!.init!.body as string).with_delimiter).toBe(false);
    expect(JSON.parse(calls[1]!.init!.body as string).cursor).toBe('c');
    expect(calls.every(c => c.url.endsWith('/storage/v1/object/list-v2/file-uploads'))).toBe(true);
  });
  test('fails on repeated Storage cursors', async () => {
    const page = { objects: [], hasNext: true, nextCursor: 'c' };
    const client = new LegacySource(ref, 'secret', fake([json(page), json(page)]));
    expect(async () => { for await (const _ of client.objects('file-uploads')) {} }).toThrow('repeated Storage cursor');
  });
});

describe('source identity and preservation', () => {
  test('resolves JSON-only sandbox IDs and records conflicting references', () => {
    const resources = new Map([['r', { type: 'sandbox', account_id: 'a', external_id: 'new' }]]);
    expect(resolveSandbox({ account_id: 'a', sandbox: { id: 'old', token: 'secret' } }, resources)).toEqual({ id: 'old', source: 'legacy-json', problems: [] });
    expect(resolveSandbox({ account_id: 'a', sandbox_resource_id: 'r', sandbox: { id: 'old' } }, resources).problems).toEqual(['sandbox-id-conflict']);
    expect(resolveSandbox({ account_id: 'b', sandbox_resource_id: 'r' }, resources).problems).toEqual(['resource-account-mismatch']);
  });
  test('stable IDs are scoped by source project and entity kind', () => {
    expect(mappedId(ref, 'session', 'a')).toBe(mappedId(ref, 'session', 'a'));
    expect(mappedId(ref, 'session', 'a')).not.toBe(mappedId('other-source', 'session', 'a'));
    expect(mappedId(ref, 'session', 'a')).not.toBe(mappedId(ref, 'message', 'a'));
  });
  test('ledger preserves every field, reruns without duplicates, and detects count mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-transfer-test-'));
    const output = join(dir, '.legacy-transfer', 'fixture');
    const ledger = new Ledger(output);
    try {
      const row = { id: 'a', type: 'status', is_llm_message: false, content: { nested: ['é', '你好'] }, metadata: { reasoning_content: 'original' } };
      ledger.begin(ref, 'messages', '{}', 1);
      ledger.save(ref, 'messages', 'id', [row]); ledger.save(ref, 'messages', 'id', [row]);
      expect(ledger.db.query('select count(*) n from records').get()).toEqual({ n: 1 });
      expect(JSON.parse((ledger.db.query('select json from records').get() as { json: string }).json)).toEqual(row);
      expect(statSync(join(output, 'ledger.sqlite')).mode & 0o777).toBe(0o600);
      expect(() => ledger.finish(ref, 'messages', '{}', 1, 2)).toThrow('export incomplete');
      expect(ledger.db.query('select status from exports').get()).toEqual({ status: 'count-mismatch' });
    } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('refuses output outside the ignored source-data directory', () => {
    expect(() => new Ledger('/tmp/unsafe-export')).toThrow('.legacy-transfer');
  });
});
