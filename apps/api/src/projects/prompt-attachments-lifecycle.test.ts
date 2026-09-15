/**
 * Delivery cost and admission for prompt attachments, with a scripted fake
 * database and a fake Storage HTTP origin. `integration-prompt-attachments.test.ts`
 * owns the real-PostgreSQL semantics: which references a release removes, the
 * budget aggregate, and the cleanup scan.
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mockConfigModule } from './reaping/test-support/mock-config';

const configModule = mockConfigModule({
  SUPABASE_URL: 'http://supabase-kong:8000',
  SUPABASE_PUBLIC_URL: 'https://preview.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  PROMPT_ATTACHMENT_UPLOAD_MODE: 'direct',
  PROMPT_ATTACHMENT_CHUNK_BYTES: 65536,
});
mock.module('../config', () => configModule);

type Op = 'select' | 'insert' | 'update' | 'delete' | 'execute';
const events: string[] = [];
let results: Partial<Record<Op, unknown[][]>> = {};
let inTransaction = false;
function respond(op: Op): unknown[] {
  events.push(`${inTransaction ? 'tx:' : ''}db:${op}`);
  return results[op]?.shift() ?? [];
}
function chain(op: Op) {
  const builder: object = new Proxy(() => {}, {
    get(_target, property) {
      if (property === 'then') {
        const result = Promise.resolve().then(() => respond(op));
        return result.then.bind(result);
      }
      return () => builder;
    },
  });
  return builder;
}
interface FakeDb {
  select(): object;
  insert(): object;
  update(): object;
  delete(): object;
  execute(): Promise<unknown[]>;
  transaction<T>(work: (tx: FakeDb) => Promise<T>): Promise<T>;
}
const fakeDb: FakeDb = {
  select: () => chain('select'),
  insert: () => chain('insert'),
  update: () => chain('update'),
  delete: () => chain('delete'),
  execute: async () => respond('execute'),
  async transaction<T>(work: (tx: FakeDb) => Promise<T>): Promise<T> {
    inTransaction = true;
    events.push('tx:begin');
    try {
      return await work(fakeDb);
    } finally {
      events.push('tx:end');
      inTransaction = false;
    }
  },
};
mock.module('../shared/db', () => ({ db: fakeDb, hasDatabase: true }));

let billing: Record<string, unknown> = { ok: true };
const billingChecks: string[] = [];
mock.module('../billing/services/billing-gate', () => ({
  checkBillingAdmission: async (accountId: string) => {
    billingChecks.push(accountId);
    return billing;
  },
  checkBillingActive: async () => {
    throw new Error('an attachment upload must not take a billing hold');
  },
}));

const storage: { method: string; path: string }[] = [];
const objects = new Map<string, Uint8Array>();
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = decodeURIComponent(new URL(request.url).pathname);
    storage.push({ method: request.method, path });
    if (path.startsWith('/storage/v1/object/upload/sign/'))
      return Response.json({ url: `${path.slice('/storage/v1'.length)}?token=upload-token` });
    if (path.startsWith('/storage/v1/object/sign/'))
      return Response.json({ signedURL: `${path.slice('/storage/v1'.length)}?token=download-token` });
    const key = path.replace(/^\/storage\/v1\/object\/(?:authenticated\/)?staged-files\//, '');
    const bytes = objects.get(key);
    return bytes ? new Response(new Uint8Array(bytes)) : Response.json({ statusCode: '404' }, { status: 400 });
  },
  { preconnect: originalFetch.preconnect },
) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const attachments = await import('./prompt-attachments');
const scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};
const commandId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const hello = new TextEncoder().encode('hello');
const ids = [
  '66666666-6666-4666-8666-666666666660',
  '66666666-6666-4666-8666-666666666661',
  '66666666-6666-4666-8666-666666666662',
];
function attachmentRow(attachmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    attachmentId,
    ...scope,
    objectPath: `prompt-attachments/${scope.projectId}/${attachmentId}`,
    filename: 'hello.txt',
    mime: 'text/plain',
    sizeBytes: hello.byteLength,
    receivedBytes: 0,
    sha256: createHash('sha256').update(hello).digest('hex'),
    status: 'ready',
    finalizeToken: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
function commandRows(attachmentIds: string[]) {
  return attachmentIds.map((attachmentId) => ({
    attachment: attachmentRow(attachmentId),
    commandStatus: 'running',
    commandPayload: {
      parts: attachmentIds.map((attachment_id) => ({ type: 'file', attachment_id })),
    },
  }));
}
const command = { commandId, projectId: scope.projectId, accountId: scope.accountId, sessionId };

beforeEach(() => {
  events.length = 0;
  storage.length = 0;
  objects.clear();
  results = {};
  billing = { ok: true };
  billingChecks.length = 0;
});

test('one metadata query for N attachments', async () => {
  results.select = [commandRows(ids)];
  const resolved = await attachments.resolvePromptAttachments({
    ...command,
    handles: ids.map((attachmentId, partIndex) => ({ attachmentId, partIndex })),
  });
  expect([...resolved.keys()]).toEqual([0, 1, 2]);
  expect(resolved.get(2)).toMatchObject({ attachmentId: ids[2], filename: 'hello.txt', size: 5 });
  expect(events).toEqual(['db:select']);
  expect(storage).toEqual([]);
});

test('no signed URL is created when unused', async () => {
  results.select = [commandRows([ids[0]!])];
  const resolved = await attachments.resolvePromptAttachment({
    ...command,
    attachmentId: ids[0]!,
    partIndex: 0,
  });
  expect(storage).toEqual([]);
  objects.set(`prompt-attachments/${scope.projectId}/${ids[0]}/file`, hello);
  expect(await resolved.readBytes()).toEqual(hello);
  expect(storage.map((call) => call.method)).toEqual(['GET']);
  expect(storage.some((call) => call.path.includes('/object/sign/'))).toBe(false);
});

test('the runtime descriptor signs exactly one download URL', async () => {
  results.select = [[{ sessionId }], commandRows([ids[0]!])];
  const descriptor = await attachments.resolveRuntimePromptAttachmentDescriptor({
    sandboxId: '77777777-7777-4777-8777-777777777777',
    accountId: scope.accountId,
    projectId: scope.projectId,
    commandId,
    attachmentId: ids[0]!,
    partIndex: 0,
  });
  expect(descriptor.download_url).toBe(
    `https://preview.example/storage/v1/object/sign/staged-files/prompt-attachments/${scope.projectId}/${ids[0]}/file?token=download-token`,
  );
  expect(storage.map((call) => `${call.method} ${call.path}`)).toEqual([
    `POST /storage/v1/object/sign/staged-files/prompt-attachments/${scope.projectId}/${ids[0]}/file`,
  ]);
});

const beginInput = { filename: 'a.txt', mime: 'text/plain', size: 5 };

test('begin within the budget counts and inserts inside one locked transaction', async () => {
  results.select = [[{ pendingHandles: 39, unboundBytes: 500 * 1024 * 1024 - 5 }]];
  results.insert = [[attachmentRow(ids[0]!, { status: 'uploading', sha256: null })]];
  const handle = await attachments.beginPromptAttachment(scope, beginInput);
  expect(handle.attachment_id).toBe(ids[0]!);
  expect(billingChecks).toEqual([scope.accountId]);
  expect(events).toEqual(['tx:begin', 'tx:db:execute', 'tx:db:select', 'tx:db:insert', 'tx:end']);
});

test('begin over the handle budget returns 429 attachment_budget_exceeded', async () => {
  results.select = [[{ pendingHandles: 40, unboundBytes: 0 }]];
  const error = await attachments.beginPromptAttachment(scope, beginInput).catch((value) => value);
  expect(error).toMatchObject({ status: 429, code: 'attachment_budget_exceeded' });
  const body = await error.res.json();
  expect(body.code).toBe('attachment_budget_exceeded');
  expect(body.error).toContain('40');
  // True after a reload too: a closed tab's unfinished uploads cannot be removed, they expire.
  expect(body.error).toContain('expire within 24 hours');
  expect(events).not.toContain('tx:db:insert');
});

test('begin over the byte budget returns 429', async () => {
  results.select = [[{ pendingHandles: 0, unboundBytes: 500 * 1024 * 1024 - 4 }]];
  const error = await attachments.beginPromptAttachment(scope, beginInput).catch((value) => value);
  expect(error).toMatchObject({ status: 429, code: 'attachment_budget_exceeded' });
  const body = await error.res.json();
  expect(body.error).toContain('500 MiB');
  // Composer attachments live in memory only, so after a reload nothing on screen can be
  // removed: the copy names the expiry instead of asking for it.
  expect(body.error).toContain('expire within 24 hours');
  expect(body.error).not.toContain('Send or remove');
  expect(events).not.toContain('tx:db:insert');
});

test('re-signing an unfinished upload is not charged against the budget', async () => {
  results.select = [[attachmentRow(ids[0]!, { status: 'uploading', sha256: null })]];
  const handle = await attachments.beginPromptAttachment(scope, {
    ...beginInput,
    attachment_id: ids[0]!,
  });
  expect(handle.upload.kind).toBe('direct');
  expect(events).toEqual(['db:select']);
  expect(billingChecks).toEqual([]);
});

test("begin with inactive billing returns the prompt path's billing error", async () => {
  billing = {
    ok: false,
    reason: 'insufficient_credits',
    message: 'Out of credits. Top up to continue.',
    balance: 0,
    billingModel: 'legacy',
    hasSubscription: false,
    billingState: 'out_of_credits',
  };
  const error = await attachments.beginPromptAttachment(scope, beginInput).catch((value) => value);
  expect(error.status).toBe(402);
  expect(await error.res.json()).toEqual({
    error: 'Out of credits. Top up to continue.',
    message: 'Out of credits. Top up to continue.',
    code: 'insufficient_credits',
    balance: 0,
    billing_model: 'legacy',
    has_subscription: false,
    billing_state: 'out_of_credits',
    account_id: scope.accountId,
  });
  expect(storage).toEqual([]);
  expect(events).toEqual([]);
});
