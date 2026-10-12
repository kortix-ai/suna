// Kortix Browser on PostgreSQL: the migration's three tables, the attach flow
// (granted at once, consent granted, consent denied), Stop denying a session,
// ask=true overriding that deny, revoke, and owner isolation.
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { BrowserError } from './logic';
import { registerSocket, unregisterSocket } from './registry';
import {
  attachBrowser,
  deleteBrowser,
  handleAttached,
  handleConsent,
  handleDetached,
  listBrowserDtos,
  patchBrowser,
  releaseBrowser,
} from './service';
import { getAttachment, upsertConnection } from './store';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const info = { brand: 'Chrome', os: 'macOS', profileLabel: 'Work', extensionVersion: '1.0.0' };
const ticket = 'dGlja2V0LWZvci10ZXN0cw';

async function connect(userId: string) {
  return upsertConnection({ userId, accountId: crypto.randomUUID(), browserId: null, info, relayOwnerId: 'test' });
}

function attach(userId: string, sessionId: string, over: { ask?: boolean; browser?: string } = {}) {
  return attachBrowser({ userId, sessionId, projectId: crypto.randomUUID(), ticket, ask: false, ...over });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof BrowserError) return err.code;
    throw err;
  }
  return 'none';
}

withDb('browser service', () => {
  test('the three tables exist with RLS on and no anon or authenticated grants', async () => {
    const rows = (await db.execute(sql`
      select c.relname, c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'select') as anon_select,
        has_table_privilege('authenticated', c.oid, 'select') as auth_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'kortix' and c.relname in ('browser_connections', 'browser_grants', 'browser_attachments')
      order by c.relname`)) as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.relname)).toEqual(['browser_attachments', 'browser_connections', 'browser_grants']);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.anon_select).toBe(false);
      expect(r.auth_select).toBe(false);
    }
  });

  test('a known browser id is reused; an unknown or foreign id creates a new row', async () => {
    const owner = crypto.randomUUID();
    const first = await connect(owner);
    const again = await upsertConnection({ userId: owner, accountId: crypto.randomUUID(), browserId: first.browserId, info, relayOwnerId: 'test' });
    expect(again.browserId).toBe(first.browserId);
    const stranger = await upsertConnection({ userId: crypto.randomUUID(), accountId: crypto.randomUUID(), browserId: first.browserId, info, relayOwnerId: 'test' });
    expect(stranger.browserId).not.toBe(first.browserId);
    expect(first.name).toBe('Chrome · Work (macOS)');
  });

  test('mode always: attach is granted at once, release ends it', async () => {
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    const result = await attach(owner, 's-always');
    expect(result.browser.id).toBe(b.browserId);
    expect((await getAttachment(result.attachmentId))?.status).toBe('granted');
    await handleAttached(b.browserId, result.attachmentId);
    expect((await getAttachment(result.attachmentId))?.status).toBe('connected');
    const listed = await listBrowserDtos(owner);
    expect(listed[0].online).toBe(true);
    expect(listed[0].activeSessions.map((s) => s.sessionId)).toEqual(['s-always']);
    await releaseBrowser({ sessionId: 's-always', attachmentId: result.attachmentId });
    expect((await getAttachment(result.attachmentId))?.status).toBe('ended');
    expect((await listBrowserDtos(owner))[0].activeSessions).toEqual([]);
  });

  test('release from another session is ignored', async () => {
    const owner = crypto.randomUUID();
    await connect(owner);
    const result = await attach(owner, 's-own');
    await releaseBrowser({ sessionId: 's-other', attachmentId: result.attachmentId });
    expect((await getAttachment(result.attachmentId))?.status).toBe('granted');
  });

  test('mode ask: the attach waits, then proceeds when the person allows the session', async () => {
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    await patchBrowser(owner, b.browserId, { accessMode: 'ask' });
    const pending = attach(owner, 's-ask');
    // Wait for the pending row, then answer in "Chrome".
    let id = '';
    for (let i = 0; i < 50 && !id; i++) {
      await Bun.sleep(100);
      const found = (await db.execute(sql`select attachment_id from kortix.browser_attachments where session_id = 's-ask'`)) as unknown as Array<{ attachment_id: string }>;
      id = found[0]?.attachment_id ?? '';
    }
    expect(id).not.toBe('');
    await handleConsent(b.browserId, id, 'session');
    const result = await pending;
    expect(result.attachmentId).toBe(id);
    // The session allow is remembered: the next attach needs no prompt.
    const next = await attach(owner, 's-ask');
    expect((await getAttachment(next.attachmentId))?.status).toBe('granted');
  });

  test('mode ask: deny in Chrome refuses with browser_denied', async () => {
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    await patchBrowser(owner, b.browserId, { accessMode: 'ask' });
    const pending = errorCode(attach(owner, 's-deny'));
    let id = '';
    for (let i = 0; i < 50 && !id; i++) {
      await Bun.sleep(100);
      const found = (await db.execute(sql`select attachment_id from kortix.browser_attachments where session_id = 's-deny'`)) as unknown as Array<{ attachment_id: string }>;
      id = found[0]?.attachment_id ?? '';
    }
    await handleConsent(b.browserId, id, 'deny');
    expect(await pending).toBe('browser_denied');
    expect(await errorCode(attach(owner, 's-deny'))).toBe('browser_denied');
  });

  test('Stop denies the session; ask=true prompts again and an allow clears the deny', async () => {
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    const first = await attach(owner, 's-stop');
    await handleDetached(b.browserId, first.attachmentId, 'stopped');
    expect((await getAttachment(first.attachmentId))?.status).toBe('ended');
    expect(await errorCode(attach(owner, 's-stop'))).toBe('browser_denied');

    const retry = attach(owner, 's-stop', { ask: true });
    let id = '';
    for (let i = 0; i < 50 && !id; i++) {
      await Bun.sleep(100);
      const found = (await db.execute(sql`select attachment_id from kortix.browser_attachments where session_id = 's-stop' and status = 'pending'`)) as unknown as Array<{ attachment_id: string }>;
      id = found[0]?.attachment_id ?? '';
    }
    await handleConsent(b.browserId, id, 'session');
    await retry;
    expect((await attach(owner, 's-stop')).attachmentId).toBeTruthy();
  });

  test('mode off refuses; a missing, unknown or offline browser gives the typed errors', async () => {
    const lonely = crypto.randomUUID();
    expect(await errorCode(attach(lonely, 's1'))).toBe('browser_not_connected');
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    expect(await errorCode(attach(owner, 's1', { browser: 'no-such-browser' }))).toBe('browser_not_found');
    await patchBrowser(owner, b.browserId, { accessMode: 'off' });
    expect(await errorCode(attach(owner, 's1'))).toBe('browser_access_off');
    await db.execute(sql`update kortix.browser_connections set last_seen_at = now() - interval '5 minutes' where browser_id = ${b.browserId}`);
    expect(await errorCode(attach(owner, 's1'))).toBe('browser_offline');
  });

  test('a second user cannot see, patch or delete the first user\'s browser', async () => {
    const owner = crypto.randomUUID();
    const other = crypto.randomUUID();
    const b = await connect(owner);
    expect(await listBrowserDtos(other)).toEqual([]);
    expect(await patchBrowser(other, b.browserId, { name: 'mine now' })).toBeNull();
    expect(await deleteBrowser(other, b.browserId)).toBe(false);
    expect((await listBrowserDtos(owner))[0].name).not.toBe('mine now');
  });

  test('delete revokes: the socket closes with 4003, open attachments end, the list drops it', async () => {
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    const sent: string[] = [];
    let closed: [number, string] | null = null;
    const ws = {
      send: (data: string) => sent.push(data),
      close: (code?: number, reason?: string) => {
        closed = [code ?? 0, reason ?? ''];
      },
    };
    registerSocket(b.browserId, ws);
    const result = await attach(owner, 's-revoke');
    expect(JSON.parse(sent[0])).toMatchObject({ type: 'attach', attachmentId: result.attachmentId, consent: false });
    expect(JSON.parse(sent[0]).bridgePath).toContain('/8000/kortix/browser/bridge?ticket=');
    expect(await deleteBrowser(owner, b.browserId)).toBe(true);
    unregisterSocket(b.browserId, ws);
    expect(closed).not.toBeNull();
    expect(closed![0]).toBe(4003);
    expect(sent.some((f) => JSON.parse(f).type === 'detach')).toBe(true);
    expect((await getAttachment(result.attachmentId))?.status).toBe('ended');
    expect(await listBrowserDtos(owner)).toEqual([]);
  });

  test('patch pushes the new state to the extension socket', async () => {
    const owner = crypto.randomUUID();
    const b = await connect(owner);
    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data), close: () => {} };
    registerSocket(b.browserId, ws);
    const dto = await patchBrowser(owner, b.browserId, { name: 'Renamed', tabScope: 'all' });
    unregisterSocket(b.browserId, ws);
    expect(dto).toMatchObject({ name: 'Renamed', tabScope: 'all' });
    expect(JSON.parse(sent[0])).toMatchObject({ type: 'browser', browser: { name: 'Renamed', tabScope: 'all' } });
  });
});
