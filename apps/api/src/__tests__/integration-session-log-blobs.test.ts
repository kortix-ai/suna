/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): F3
 * large texts (P2.3). A text block or a tool result text over 256 kB leaves the
 * row: the row keeps a 16 kB preview, `ref` and `bytes`, the full text is one
 * object in the `session-attachments` bucket, and `session_log_blobs` indexes it.
 *
 * Real: every row, the journal and log routes, the session PAT, account erasure.
 * Fake: the Storage bucket (`helpers/fake-session-storage.ts`), which answers as
 * Supabase Storage does. The worktree stack run proves the real bucket.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { accountMembers, sessionLogBlobs, sessionLogMessages, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { ingestSessionLogJournal, sessionLogContentHash } = await import('../projects/session-log-ingest');
const { rehydrateLargeTexts } = await import('../projects/session-log-blobs');
const { readSessionLogPage } = await import('../projects/session-log-read');
const { deleteAccountExternalStores } = await import('../billing/services/account-erasure-stores');

const OWNER = crypto.randomUUID();
const REV = 1_791_681_474_704_000;
const T = '2026-10-11T10:00:00.000Z';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MIME = 'text/plain; charset=utf-8';

// Synthetic texts: 1,000,000 base64 characters, and 300,000 bytes of a 3-byte character.
const TOOL_OUTPUT = randomBytes(750_000).toString('base64');
const WIDE_TEXT = '€'.repeat(100_000);

let project: SeededProject;
let session = '';
let sessionToken = '';
let ownerToken = '';

const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1' };
const message = (id: string, seq: number, blocks: unknown[], over: Record<string, unknown> = {}) => ({
  schema: 'kortix.session/2', v: 1, message_id: id, thread_id: 'main', seq,
  role: 'assistant', kind: 'turn', status: 'complete', in_context: true,
  model: null, usage: null, finish: null, error: null,
  created_at: T, completed_at: null, producer, blocks, ext: {}, ...over,
});
const toolCall = (id: string, output: string) => ({
  type: 'tool_call', id, call_id: `call_${id}`, name: 'bash', kind: 'shell', input: { command: 'seq 1 200000' },
  status: 'complete', result: { content: [{ type: 'text', text: output }], is_error: false, exit_code: 0 },
});
const thread = { schema: 'kortix.session/2', v: 1, thread_id: 'main', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: T, ext: {} };
type Put = { rev: number; message: Record<string, unknown> };
type ToolRecord = { blocks: Array<{ result: { content: Array<{ type: string; text: string; ref?: string; bytes?: number }> } }> };
const batch = (puts: Put[]) => ({ generation: 0, puts, tombstones: [], threads: [thread] });

const base = (sessionId = session) => `/v1/projects/${project.project_id}/sessions/${sessionId}`;
const journal = (body: unknown) =>
  app.request(`${base()}/log/journal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${sessionToken}` },
    body: Bun.gzipSync(JSON.stringify(body)) as BodyInit,
  });
const stored = async (id: string, sessionId = session) =>
  (await db.select().from(sessionLogMessages).where(and(eq(sessionLogMessages.sessionId, sessionId), eq(sessionLogMessages.messageId, id))))[0];
const blobRows = (sessionId = session) => db.select().from(sessionLogBlobs).where(eq(sessionLogBlobs.sessionId, sessionId));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const objectKey = (ref: string) => ref.replace('kortix-attachment://', '');

const toolMessage = message('msg_tool', 1, [toolCall('prt_tool', TOOL_OUTPUT)]);
const userMessage = message('msg_user', 0, [{ type: 'text', id: 'prt_user', text: WIDE_TEXT }], { role: 'user' });

beforeAll(async () => {
  project = await seedProject('session-log-blobs');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  session = await seedSession(project, OWNER);
  // A session PAT authenticates only while its sandbox row is live (the session lease).
  await db.insert(sessionSandboxes).values({ sandboxId: session, sessionId: session, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
  sessionToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId: session, name: 'session-log-blobs-box' })).secretKey;
  ownerToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-blobs-owner' })).secretKey;
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await removeSeeded([project]);
});

describe('a text over 256 kB is stored by reference', () => {
  test('a 1 MB tool output and a 300 kB text keep a 16 kB preview, ref and bytes; the bucket holds the full texts', async () => {
    const res = await journal(batch([{ rev: REV + 1, message: userMessage }, { rev: REV + 2, message: toolMessage }]));
    expect(res.status).toBe(200);

    const tool = await stored('msg_tool');
    const content = (tool!.record as ToolRecord).blocks[0]!.result.content[0] as { text: string; ref: string; bytes: number };
    expect(content.text).toBe(TOOL_OUTPUT.slice(0, 16 * 1024));
    expect(content.bytes).toBe(1_000_000);
    expect(content.ref).toMatch(new RegExp(`^kortix-attachment://${project.project_id}/${session}/${UUID}$`));
    // Everything but the text item is the record as sent.
    const { text: _t, ref: _r, bytes: _b, ...restOfItem } = content;
    expect(restOfItem).toEqual({ type: 'text' });
    expect({ ...(tool!.record as object), blocks: [] }).toEqual({ ...toolMessage, blocks: [] });
    expect(Buffer.byteLength(JSON.stringify(tool!.record))).toBeLessThan(20_000);

    // The preview never cuts a UTF-8 sequence: 5,461 three-byte characters are 16,383 bytes.
    const user = (await stored('msg_user'))!.record as { blocks: Array<{ text: string; ref: string; bytes: number }> };
    expect(user.blocks[0]!.text).toBe('€'.repeat(5_461));
    expect(user.blocks[0]!.bytes).toBe(300_000);

    const blobs = await blobRows();
    expect(blobs.map((b) => ({ sha256: b.sha256, objectKey: b.objectKey, bytes: b.bytes, mime: b.mime, deletedAt: b.deletedAt })).sort((a, b) => a.bytes - b.bytes)).toEqual([
      { sha256: sha256(WIDE_TEXT), objectKey: objectKey(user.blocks[0]!.ref), bytes: 300_000, mime: MIME, deletedAt: null },
      { sha256: sha256(TOOL_OUTPUT), objectKey: objectKey(content.ref), bytes: 1_000_000, mime: MIME, deletedAt: null },
    ]);
    expect(await bucket.objects.get(objectKey(content.ref))!.text()).toBe(TOOL_OUTPUT);
    expect(await bucket.objects.get(objectKey(user.blocks[0]!.ref))!.text()).toBe(WIDE_TEXT);
    expect(bucket.uploads).toHaveLength(2);
  });

  test('the manifest reports the hash of the record as the daemon sent it', async () => {
    const res = await app.request(`${base()}/log/manifest`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ message_id: string; content_hash: string }> };
    expect(body.messages.find((m) => m.message_id === 'msg_tool')?.content_hash).toBe(sessionLogContentHash(toolMessage));
    expect(body.messages.find((m) => m.message_id === 'msg_user')?.content_hash).toBe(sessionLogContentHash(userMessage));
  });

  test('a re-sent batch and a later revision with the same text upload nothing again', async () => {
    expect((await journal(batch([{ rev: REV + 1, message: userMessage }, { rev: REV + 2, message: toolMessage }]))).status).toBe(200);
    const revised = { ...toolMessage, finish: 'stop' };
    expect((await journal(batch([{ rev: REV + 3, message: revised }]))).status).toBe(200);
    expect(bucket.uploads).toHaveLength(2);
    expect(await blobRows()).toHaveLength(2);
    const row = await stored('msg_tool');
    expect((row!.record as { finish: string }).finish).toBe('stop');
    expect(row!.contentHash).toBe(sessionLogContentHash(revised));
  });

  test('a text of exactly 256 kB, and a small one, stay in the row as sent', async () => {
    const edge = message('msg_edge', 2, [{ type: 'text', id: 'prt_edge', text: 'x'.repeat(256 * 1024) }, toolCall('prt_small', 'ok\n')]);
    expect((await journal(batch([{ rev: REV + 4, message: edge }]))).status).toBe(200);
    expect((await stored('msg_edge'))!.record).toEqual(edge);
    expect(bucket.uploads).toHaveLength(2);
  });

  test('GET .../log serves the preview and the reference, not the object', async () => {
    const res = await app.request(`${base()}/log?limit=40`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw.length).toBeLessThan(400_000);
    const page = JSON.parse(raw) as { messages: Array<{ message_id: string; blocks: Array<{ result?: { content: Array<{ ref?: string; bytes?: number }> } }> }> };
    const item = page.messages.find((m) => m.message_id === 'msg_tool')!.blocks[0]!.result!.content[0]!;
    expect(item.ref).toMatch(/^kortix-attachment:\/\//);
    expect(item.bytes).toBe(1_000_000);
  });

  test('the full texts come back for a session read, and a reference to another session is never followed', async () => {
    const tool = (await stored('msg_tool'))!.record;
    const [full] = await rehydrateLargeTexts({ projectId: project.project_id, sessionId: session }, [tool]);
    const item = (full as ToolRecord).blocks[0]!.result.content[0];
    expect(item).toEqual({ type: 'text', text: TOOL_OUTPUT });
    // The row itself is untouched.
    expect((tool as ToolRecord).blocks[0]!.result.content[0]!.ref).toBeDefined();

    // A daemon can send any `ref`. One that names another project's object is stored as sent and never read.
    const foreign = `${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    bucket.objects.set(foreign, new Blob(['another tenant']));
    const forged = message('msg_forged', 3, [{ type: 'text', id: 'prt_forged', text: 'preview', ref: `kortix-attachment://${foreign}`, bytes: 14 }]);
    expect((await journal(batch([{ rev: REV + 5, message: forged }]))).status).toBe(200);
    const row = (await stored('msg_forged'))!.record;
    expect(row).toEqual(forged);
    expect(await rehydrateLargeTexts({ projectId: project.project_id, sessionId: session }, [row])).toEqual([row]);

    // A text over 256 kB is offloaded whatever `ref` the daemon sent with it: the API's own `ref` replaces it.
    const bloated = message('msg_bloated', 4, [{ type: 'text', id: 'prt_bloated', text: WIDE_TEXT, ref: `kortix-attachment://${foreign}`, bytes: 14 }]);
    expect((await journal(batch([{ rev: REV + 6, message: bloated }]))).status).toBe(200);
    const block = ((await stored('msg_bloated'))!.record as { blocks: Array<{ text: string; ref: string; bytes: number }> }).blocks[0]!;
    // The same text as msg_user: the same object, and no second upload.
    expect(block.ref).toBe(((await stored('msg_user'))!.record as { blocks: Array<{ ref: string }> }).blocks[0]!.ref);
    expect(bucket.uploads).toHaveLength(2);
    expect(block.bytes).toBe(300_000);
    expect(block.text).toBe('€'.repeat(5_461));
    bucket.objects.delete(foreign);
  });

  test('a Storage error degrades one text to its preview; the read still answers', async () => {
    const tool = (await stored('msg_tool'))!.record;
    bucket.failDownloads.next = 1;
    const [served] = await rehydrateLargeTexts({ projectId: project.project_id, sessionId: session }, [tool]);
    expect(served).toEqual(tool);
    expect(bucket.failDownloads.next).toBe(0);
  });

  test('a 50 MB tool output stays out of the row: a page of 40 reads as fast as a session without it', async () => {
    const seed = async (last: unknown) => {
      const sessionId = await seedSession(project, OWNER);
      const puts = [
        ...Array.from({ length: 39 }, (_, i) => ({ rev: REV + i, message: message(`msg_s${i}`, i, [{ type: 'text', id: `prt_s${i}`, text: `turn ${i}` }]) })),
        { rev: REV + 39, message: message('msg_last', 39, [last]) },
      ];
      // The route takes 16 MB raw per batch; the service has no such cap, so this seeds a 50 MB text directly.
      const outcome = await ingestSessionLogJournal({ sessionId, projectId: project.project_id, accountId: project.account_id }, batch(puts) as never);
      expect(outcome.status).toBe(200);
      return sessionId;
    };
    // Random base64 (50,000,000 characters): PostgreSQL's TOAST compression cannot shrink it, as it would a repeated text.
    const big = await seed(toolCall('prt_big', randomBytes(37_500_000).toString('base64')));
    const small = await seed(toolCall('prt_small', 'ok\n'));
    const [size] = await db.execute<{ n: number }>(sql`select pg_column_size(record)::int as n from kortix.session_log_messages where session_id = ${big} and message_id = 'msg_last'`);
    expect(size!.n).toBeLessThan(20_000);
    expect(bucket.objects.get((await blobRows(big))[0]!.objectKey)!.size).toBe(50_000_000);

    const service = (sessionId: string) => async () =>
      ((await readSessionLogPage({ sessionId, threadId: null, beforeSeq: null, limit: 40 })) as { messages: unknown[] }).messages.length;
    const readBig = service(big);
    const readSmall = service(small);
    // Interleaved, not two sequential loops: both p50s then span the same
    // machine conditions. A sequential pair measures the 50 MB session first,
    // so any load burst on that loop alone (a sibling suite in the 6-worker
    // db-suites lane, a cold JIT or plan cache) reds it, while the second
    // loop's clean p50 sets the budget. Relative, not absolute: a loaded
    // machine slows both reads alike. Reading the object would cost ~100x.
    const withText: number[] = [];
    const without: number[] = [];
    for (let i = 0; i < 200; i++) {
      let started = performance.now();
      expect(await readBig()).toBe(40);
      withText.push(performance.now() - started);
      started = performance.now();
      expect(await readSmall()).toBe(40);
      without.push(performance.now() - started);
    }
    const p50 = (timings: number[]) => timings.sort((a, b) => a - b)[99]!;
    const withP50 = p50(withText);
    const withoutP50 = p50(without);
    console.info(`[session-log-blobs] readSessionLogPage p50: 50 MB tool output ${withP50.toFixed(2)} ms, no large text ${withoutP50.toFixed(2)} ms (200 interleaved reads each)`);
    expect(withP50).toBeLessThanOrEqual(2 * withoutP50 + 1);
  }, 120_000);

  test('account erasure deletes the objects', async () => {
    expect([...bucket.objects.keys()].some((k) => k.startsWith(`${project.project_id}/`))).toBe(true);
    await deleteAccountExternalStores(project.account_id);
    expect([...bucket.objects.keys()].filter((k) => k.startsWith(`${project.project_id}/`))).toEqual([]);
  });
});

describe('attachment bytes the journal uploads (P2.13)', () => {
  // A synthetic 2x2 PNG.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgaPgPQhAKACX2Bf2gcp/LAAAAAElFTkSuQmCC', 'base64');
  const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
  let box = '';
  let boxToken = '';
  const blob = (sha: string, init: RequestInit = {}, token = boxToken) =>
    app.request(`${base(box)}/log/blobs/${sha}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
  const put = (bytes: Buffer, sha = createHash('sha256').update(bytes).digest('hex'), mime = 'image/png', token = boxToken) =>
    blob(sha, { method: 'PUT', headers: { 'Content-Type': mime }, body: new Uint8Array(bytes) }, token);

  beforeAll(async () => {
    box = await seedSession(project, OWNER);
    await db.insert(sessionSandboxes).values({ sandboxId: box, sessionId: box, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
    boxToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId: box, name: 'session-log-blobs-attachments' })).secretKey;
  });

  test('an unknown sha256 answers ref null; the upload stores the bytes once and answers the ref; the lookup then answers it', async () => {
    const before = bucket.uploads.length;
    const missing = await blob(PNG_SHA);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ref: null });

    const first = await put(PNG);
    expect(first.status).toBe(200);
    const { ref } = (await first.json()) as { ref: string };
    expect(ref).toMatch(new RegExp(`^kortix-attachment://${project.project_id}/${box}/${UUID}$`));
    const object = bucket.objects.get(objectKey(ref))!;
    expect(Buffer.from(await object.arrayBuffer())).toEqual(PNG);
    expect(object.type).toBe('image/png');
    expect((await blobRows(box)).map((b) => ({ sha256: b.sha256, objectKey: b.objectKey, bytes: b.bytes, mime: b.mime }))).toEqual([
      { sha256: PNG_SHA, objectKey: objectKey(ref), bytes: PNG.length, mime: 'image/png' },
    ]);
    // The same image again: the same ref, no second upload.
    expect(await (await put(PNG)).json()).toEqual({ ref });
    expect(await (await blob(PNG_SHA)).json()).toEqual({ ref });
    expect(bucket.uploads.length - before).toBe(1);

    // The box reads it back through the attachments route, as a restore does.
    const read = await app.request(`${base(box)}/attachments/${ref.split('/').at(-1)}`, { headers: { Authorization: `Bearer ${boxToken}` } });
    expect(read.status).toBe(200);
    expect(createHash('sha256').update(Buffer.from(await read.arrayBuffer())).digest('hex')).toBe(PNG_SHA);

    // A record naming the object is stored as sent: GET .../log serves the ref, sha256 and bytes.
    const image = { type: 'attachment', id: 'prt_img', ref, mime: 'image/png', bytes: PNG.length, sha256: PNG_SHA };
    const res = await app.request(`${base(box)}/log/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${boxToken}` },
      body: Bun.gzipSync(JSON.stringify(batch([{ rev: REV + 1, message: message('msg_img', 0, [image], { role: 'user' }) }]))) as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(((await stored('msg_img', box))!.record as { blocks: unknown[] }).blocks).toEqual([image]);
  });

  test('a body whose sha256 is not the path, a bad sha256 or Content-Type → 400; a token not bound to the session → 403; nothing stored', async () => {
    const before = bucket.uploads.length;
    expect((await put(PNG, '0'.repeat(64))).status).toBe(400);
    expect((await put(PNG, 'not-a-sha')).status).toBe(400);
    expect((await put(Buffer.from('x'), undefined, 'not a mime')).status).toBe(400);
    expect((await put(Buffer.from('owner bytes'), undefined, 'image/png', ownerToken)).status).toBe(403);
    expect((await blob(PNG_SHA, {}, ownerToken)).status).toBe(403);
    expect(bucket.uploads.length).toBe(before);
  });

  test('a body over 50 MiB → 413; the operator switch off → 503 on both routes; nothing stored', async () => {
    const before = bucket.uploads.length;
    const big = Buffer.alloc(50 * 1024 * 1024 + 1);
    expect((await put(big, '0'.repeat(64))).status).toBe(413);
    const { config } = await import('../config');
    config.SESSION_LOG_INGEST_ENABLED = false;
    try {
      expect((await blob(PNG_SHA)).status).toBe(503);
      expect((await put(PNG)).status).toBe(503);
    } finally {
      config.SESSION_LOG_INGEST_ENABLED = true;
    }
    expect(bucket.uploads.length).toBe(before);
  });

  test('a text and an attachment with the same bytes share one object', async () => {
    const text = 'x'.repeat(300_000);
    const sha = sha256(text);
    const res = await app.request(`${base(box)}/log/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${boxToken}` },
      body: Bun.gzipSync(JSON.stringify(batch([{ rev: REV + 2, message: message('msg_big', 1, [{ type: 'text', id: 'prt_big', text }]) }]))) as BodyInit,
    });
    expect(res.status).toBe(200);
    const textRef = ((await stored('msg_big', box))!.record as { blocks: Array<{ ref: string }> }).blocks[0]!.ref;
    expect(await (await put(Buffer.from(text), sha, 'text/plain')).json()).toEqual({ ref: textRef });
  });

  test('session deletion removes the index rows (cascade) and account erasure the objects', async () => {
    expect((await blobRows(box)).length).toBe(2);
    await deleteAccountExternalStores(project.account_id);
    expect([...bucket.objects.keys()].filter((k) => k.startsWith(`${project.project_id}/${box}/`))).toEqual([]);
    await db.execute(sql`delete from kortix.project_sessions where session_id = ${box}`);
    expect(await blobRows(box)).toEqual([]);
  });
});
