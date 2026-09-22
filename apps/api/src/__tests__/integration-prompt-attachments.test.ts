import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import {
  promptAttachments,
  promptAttachmentReferences,
  projects,
  sessionSandboxes,
  sessionLifecycleCommands,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { config } from '../config';
import {
  beginPromptAttachment,
  bindPromptAttachments,
  cleanupExpiredPromptAttachments,
  completePromptAttachment,
  deletePromptAttachment,
  resolvePromptAttachment,
  resolveRuntimePromptAttachmentDescriptor,
  uploadPromptAttachmentChunk,
} from '../projects/prompt-attachments';
import {
  claimCreateSessionCommand,
  enqueueContinueSessionCommand,
} from '../projects/session-lifecycle/store';
import { deleteInboxPrompt } from '../projects/session-lifecycle/inbox-rows';

// Real PostgreSQL transactions; only the external storage transport is replaced
// to reproduce an object write whose successful response is lost.
const scope = {
  accountId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
};
const sessionId = crypto.randomUUID();
const sandboxId = crypto.randomUUID();
const objects = new Map<string, Uint8Array>();
const originalFetch = globalThis.fetch;
let failWrite = false;
let failRemove = false;
let deferWrite = false;
let settleWrite: (() => void) | undefined;
beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO kortix.accounts(account_id,name) VALUES(${scope.accountId}::uuid,'attachment-it')`,
  );
  await db.execute(
    sql`INSERT INTO kortix.projects(project_id,account_id,name,repo_url) VALUES(${scope.projectId}::uuid,${scope.accountId}::uuid,'attachment-it','https://example.invalid/r.git')`,
  );
  await db.execute(
    sql`INSERT INTO kortix.project_sessions(session_id,account_id,project_id,branch_name,status) VALUES(${sessionId},${scope.accountId}::uuid,${scope.projectId}::uuid,${sessionId},'running')`,
  );
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId: scope.accountId,
    projectId: scope.projectId,
    status: 'active',
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = decodeURIComponent(new URL(request.url).pathname).replace(
        /^\/storage\/v1\/object\/(?:authenticated\/|sign\/|upload\/sign\/)?staged-files\/?/,
        '',
      );
      if (request.url.includes('/object/upload/sign/'))
        return Response.json({ url: `/object/upload/sign/staged-files/${path}?token=fake` });
      if (request.method === 'DELETE') {
        if (failRemove)
          return Response.json({ message: 'injected remove failure' }, { status: 503 });
        const { prefixes } = (await request.json()) as { prefixes: string[] };
        prefixes.forEach((key) => objects.delete(key));
        return Response.json([]);
      }
      if (request.url.includes('/object/sign/'))
        return Response.json({ signedURL: `/object/sign/staged-files/${path}?token=fake` });
      if (request.method === 'POST') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (deferWrite) {
          deferWrite = false;
          settleWrite = () => {
            objects.set(path, bytes);
          };
          return Response.json({ message: 'upstream write is still pending' }, { status: 503 });
        }
        objects.set(path, bytes);
        if (failWrite) {
          failWrite = false;
          return Response.json({ message: 'lost write response' }, { status: 503 });
        }
        return Response.json({ Key: path });
      }
      const bytes = objects.get(path);
      return bytes
        ? new Response(new Uint8Array(bytes))
        : Response.json({ message: 'missing' }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId));
  await db
    .delete(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.projectId, scope.projectId));
  await db.delete(promptAttachments).where(eq(promptAttachments.projectId, scope.projectId));
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id=${sessionId}`);
  await db.delete(projects).where(eq(projects.projectId, scope.projectId));
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id=${scope.accountId}::uuid`);
});
async function ready() {
  const handle = await beginPromptAttachment(scope, {
    filename: 'proof.txt',
    mime: 'text/plain',
    size: 3,
  });
  // Direct mode: the client PUTs to the signed URL, so the fake Storage holds the object.
  objects.set(
    `prompt-attachments/${scope.projectId}/${handle.attachment_id}/file`,
    new Uint8Array([1, 2, 3]),
  );
  await completePromptAttachment(scope, handle.attachment_id);
  return handle.attachment_id;
}
/** Runs `work` with the preview's chunked transport selected. */
async function inChunkedMode(work: () => Promise<void>) {
  const previous = config.PROMPT_ATTACHMENT_UPLOAD_MODE;
  config.PROMPT_ATTACHMENT_UPLOAD_MODE = 'chunked';
  try {
    await work();
  } finally {
    config.PROMPT_ATTACHMENT_UPLOAD_MODE = previous;
  }
}
function enqueue(id: string, clientMessageId = crypto.randomUUID()) {
  return enqueueContinueSessionCommand({
    source: 'ui',
    ...scope,
    actorUserId: scope.userId,
    sessionId,
    text: 'proof',
    clientMessageId,
    idempotencyKey: `prompt:${sessionId}:${clientMessageId}`,
    parts: [{ type: 'file', attachment_id: id, filename: 'spoof.txt' }],
  });
}
async function expire(id: string) {
  await db
    .update(promptAttachments)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(promptAttachments.attachmentId, id));
}

test('ambiguous chunk and final-object writes retry idempotently with tracked object names', () => inChunkedMode(async () => {
  const handle = await beginPromptAttachment(scope, {
    filename: 'proof.txt',
    mime: 'text/plain',
    size: 3,
  });
  failWrite = true;
  await expect(
    uploadPromptAttachmentChunk(scope, handle.attachment_id, 0, new Uint8Array([1, 2, 3])),
  ).rejects.toThrow('upload failed');
  expect(objects.size).toBeGreaterThan(0);
  const [row] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, handle.attachment_id));
  expect(row.receivedBytes).toBe(0);
  expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(
    await uploadPromptAttachmentChunk(scope, handle.attachment_id, 0, new Uint8Array([1, 2, 3])),
  ).toEqual({ received_bytes: 3, size: 3 });
  failWrite = true;
  await expect(completePromptAttachment(scope, handle.attachment_id)).rejects.toThrow(
    'processing failed',
  );
  expect((await completePromptAttachment(scope, handle.attachment_id)).attachment_id).toBe(
    handle.attachment_id,
  );
  expect((await completePromptAttachment(scope, handle.attachment_id)).attachment_id).toBe(
    handle.attachment_id,
  );
}));

test('command payload and reference commit together; retries do not add references', async () => {
  const id = await ready();
  const key = crypto.randomUUID();
  const first = await enqueue(id, key);
  const second = await enqueue(id, key);
  expect(second.row.commandId).toBe(first.row.commandId);
  expect(second.deduped).toBe(true);
  expect(first.row.payload.parts).toEqual([
    { type: 'file', attachment_id: id, filename: 'proof.txt', mime: 'text/plain' },
  ]);
  const refs = await db
    .select()
    .from(promptAttachmentReferences)
    .where(eq(promptAttachmentReferences.attachmentId, id));
  expect(refs).toHaveLength(1);
  await expect(
    resolvePromptAttachment({
      attachmentId: id,
      commandId: first.row.commandId,
      projectId: scope.projectId,
      accountId: scope.accountId,
      sessionId,
      partIndex: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await db
    .update(sessionLifecycleCommands)
    .set({ status: 'running' })
    .where(eq(sessionLifecycleCommands.commandId, first.row.commandId));
  const resolved = await resolvePromptAttachment({
    attachmentId: id,
    commandId: first.row.commandId,
    projectId: scope.projectId,
    accountId: scope.accountId,
    sessionId,
    partIndex: 0,
  });
  expect(await resolved.readBytes()).toEqual(new Uint8Array([1, 2, 3]));
  await expire(id);
  expect(
    await resolvePromptAttachment({
      attachmentId: id,
      commandId: first.row.commandId,
      projectId: scope.projectId,
      accountId: scope.accountId,
      sessionId,
      partIndex: 0,
    }),
  ).toMatchObject({ filename: 'proof.txt', size: 3 });
  await expect(
    resolvePromptAttachment({
      attachmentId: id,
      commandId: first.row.commandId,
      projectId: scope.projectId,
      accountId: scope.accountId,
      sessionId,
      partIndex: 1,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    resolvePromptAttachment({
      attachmentId: id,
      commandId: first.row.commandId,
      projectId: scope.projectId,
      accountId: scope.accountId,
      sessionId: crypto.randomUUID(),
      partIndex: 0,
    }),
  ).rejects.toThrow('unavailable');
});

// Guard ORDER, not just the two guards. A wrong part index is a permanent
// caller error; the command's status is a transient server state. Resolving the
// status first made the permanent 404 unreachable whenever the command had left
// `running`, so the same wrong index answered 404 or 409 purely on timing.
// SESS-30 asserts the 404 and saw both. Assert the code, not only the status,
// so a caller can still tell "wrong index" from "wrong time".
test('a wrong part index reports 404 whether or not the command is running', async () => {
  const id = await ready();
  const clientMessageId = crypto.randomUUID();
  // SESS-30's shape: a text part at index 0, the file part at index 1.
  const command = await enqueueContinueSessionCommand({
    source: 'ui',
    ...scope,
    actorUserId: scope.userId,
    sessionId,
    text: 'proof',
    clientMessageId,
    idempotencyKey: `prompt:${sessionId}:${clientMessageId}`,
    parts: [
      { type: 'text', text: 'proof' },
      { type: 'file', attachment_id: id, filename: 'spoof.txt' },
    ],
  });
  const commandId = command.row.commandId;
  const handle = (partIndex: number) => ({
    attachmentId: id,
    commandId,
    projectId: scope.projectId,
    accountId: scope.accountId,
    sessionId,
    partIndex,
  });
  const setStatus = (status: 'queued' | 'running') =>
    db
      .update(sessionLifecycleCommands)
      .set({ status })
      .where(eq(sessionLifecycleCommands.commandId, commandId));

  await setStatus('running');
  expect(await resolvePromptAttachment(handle(1))).toMatchObject({ filename: 'proof.txt' });
  // Index 0 names the text part: permanently wrong for this attachment.
  await expect(resolvePromptAttachment(handle(0))).rejects.toMatchObject({
    status: 404,
    code: 'attachment_not_found',
  });

  await setStatus('queued');
  // A valid index keeps the transient answer: retrying once the command runs works.
  await expect(resolvePromptAttachment(handle(1))).rejects.toMatchObject({
    status: 409,
    code: 'attachment_command_not_running',
  });
  // The same wrong index stays permanently wrong. No retry can fix it, so the
  // transient 409 must not mask it.
  await expect(resolvePromptAttachment(handle(0))).rejects.toMatchObject({
    status: 404,
    code: 'attachment_not_found',
  });
});

test('runtime descriptor requires the live sandbox and exact running command part', async () => {
  const id = await ready();
  const command = await enqueue(id);
  await db
    .update(sessionLifecycleCommands)
    .set({ status: 'running' })
    .where(eq(sessionLifecycleCommands.commandId, command.row.commandId));

  const descriptor = await resolveRuntimePromptAttachmentDescriptor({
    sandboxId,
    accountId: scope.accountId,
    projectId: scope.projectId,
    commandId: command.row.commandId,
    attachmentId: id,
    partIndex: 0,
  });

  expect(descriptor).toMatchObject({
    version: 1,
    command_id: command.row.commandId,
    attachment_id: id,
    part_index: 0,
    filename: 'proof.txt',
    mime: 'text/plain',
    size_bytes: 3,
    target_path: `/workspace/uploads/.kortix-inbox/${command.row.commandId}/0-proof.txt`,
  });
  expect(descriptor.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(descriptor.download_url).toContain('token=fake');
  expect(JSON.stringify(descriptor)).not.toContain('object_path');
  await expect(
    resolveRuntimePromptAttachmentDescriptor({
      sandboxId: crypto.randomUUID(),
      accountId: scope.accountId,
      projectId: scope.projectId,
      commandId: command.row.commandId,
      attachmentId: id,
      partIndex: 0,
    }),
  ).rejects.toMatchObject({ status: 404 });
});

test('expired, foreign and malformed bindings roll back their newly inserted commands', async () => {
  const id = await ready();
  await expire(id);
  const key = crypto.randomUUID();
  await expect(enqueue(id, key)).rejects.toThrow('expired');
  const rows = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, `prompt:${sessionId}:${key}`));
  expect(rows).toHaveLength(0);
  const fresh = await ready();
  await expect(
    db.transaction(async (tx) => {
      const [command] = await tx
        .insert(sessionLifecycleCommands)
        .values({
          commandType: 'continue_session',
          source: 'ui',
          ...scope,
          actorUserId: crypto.randomUUID(),
          sessionId,
          payload: { parts: [{ type: 'file', attachment_id: fresh }] },
        })
        .returning();
      await bindPromptAttachments(tx, command);
    }),
  ).rejects.toThrow('not found');
  await expect(
    db.transaction(async (tx) => {
      const [command] = await tx
        .insert(sessionLifecycleCommands)
        .values({
          commandType: 'create_session',
          source: 'ui',
          ...scope,
          actorUserId: scope.userId,
          payload: {
            body: { pending_prompt: { parts: [{ type: 'file', attachment_id: 'invalid' }] } },
          },
        })
        .returning();
      await bindPromptAttachments(tx, command);
    }),
  ).rejects.toThrow('UUID');
});

test('queued first-session reference survives expiry and transfers only from its trusted command', async () => {
  const id = await ready();
  const [project] = await db.select().from(projects).where(eq(projects.projectId, scope.projectId));
  const created = await claimCreateSessionCommand(
    {
      source: 'ui',
      project,
      userId: scope.userId,
      requestingPrincipalType: 'human',
      body: { pending_prompt: { text: 'proof', parts: [{ type: 'file', attachment_id: id }] } },
      idempotencyKey: crypto.randomUUID(),
    },
    { initialStatus: 'queued' },
  );
  await expire(id);
  await db.transaction(async (tx) => {
    const [command] = await tx
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'continue_session',
        source: 'ui',
        ...scope,
        actorUserId: scope.userId,
        sessionId,
        payload: { parts: [{ type: 'file', attachment_id: id }] },
      })
      .returning();
    await bindPromptAttachments(tx, command, created.row.commandId);
  });
  expect(
    await db
      .select()
      .from(promptAttachmentReferences)
      .where(eq(promptAttachmentReferences.attachmentId, id)),
  ).toHaveLength(2);
  await expect(enqueue(id)).rejects.toThrow('expired');
  await cleanupExpiredPromptAttachments();
  expect(
    await db.select().from(promptAttachments).where(eq(promptAttachments.attachmentId, id)),
  ).toHaveLength(1);
});

test('cleanup retains active finalization and retries storage deletion before metadata removal', async () => {
  const id = await ready();
  await expire(id);
  await db
    .update(promptAttachments)
    .set({ status: 'finalizing', updatedAt: new Date() })
    .where(eq(promptAttachments.attachmentId, id));
  await cleanupExpiredPromptAttachments();
  expect(
    await db.select().from(promptAttachments).where(eq(promptAttachments.attachmentId, id)),
  ).toHaveLength(1);
  await db
    .update(promptAttachments)
    .set({ status: 'ready' })
    .where(eq(promptAttachments.attachmentId, id));
  failRemove = true;
  expect((await cleanupExpiredPromptAttachments()).errors).toBeGreaterThan(0);
  expect(
    await db.select().from(promptAttachments).where(eq(promptAttachments.attachmentId, id)),
  ).toHaveLength(1);
  failRemove = false;
  await cleanupExpiredPromptAttachments();
  expect(
    await db.select().from(promptAttachments).where(eq(promptAttachments.attachmentId, id)),
  ).toHaveLength(0);
});

test('removing an expired queued command gives Undo a fresh owner-scoped attachment grace period', async () => {
  const id = await ready();
  const first = await enqueue(id);
  await expire(id);
  expect((await deleteInboxPrompt(sessionId, first.row.commandId)).outcome).toBe('deleted');
  await cleanupExpiredPromptAttachments();
  const restored = await enqueue(id);
  expect(restored.row.payload.parts).toEqual([
    { type: 'file', attachment_id: id, filename: 'proof.txt', mime: 'text/plain' },
  ]);
});

test('cleanup rechecks references committed after its candidate snapshot but before tuple locking', async () => {
  const id = await ready();
  const [initial] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, id));
  const cleanupAt = new Date(initial.expiresAt.getTime() + 1);
  const transaction = db.transaction.bind(db);
  // Replay the READ COMMITTED interleaving deterministically: candidate SELECT
  // sees no reference, binding commits without changing the attachment tuple,
  // then cleanup acquires the tuple lock and receives its stale candidate.
  // The sweep's first transaction is the delivery release, which runs as is;
  // the second is the batch claim this test intercepts.
  const intercepted = spyOn(db, 'transaction')
    .mockImplementationOnce((work) => transaction(work))
    .mockImplementationOnce((work) =>
    transaction(async (tx) => {
      const proxy = new Proxy(tx, {
        get(target, property) {
          if (property !== 'select') return Reflect.get(target, property, target);
          return (...args: Parameters<typeof tx.select>) => {
            const selection = tx.select(...args);
            const from = selection.from.bind(selection);
            selection.from = ((...fromArgs: Parameters<typeof from>) => {
              const query = from(...fromArgs);
              query.for = () => {
                const result = (async () => {
                  const candidates = await query;
                  await enqueue(id);
                  await tx
                    .select()
                    .from(promptAttachments)
                    .where(eq(promptAttachments.attachmentId, id))
                    .for('update');
                  return candidates;
                })();
                return new Proxy(query, {
                  get(target, property, receiver) {
                    if (property === 'then') return result.then.bind(result);
                    return Reflect.get(target, property, receiver);
                  },
                });
              };
              return query;
            }) as typeof selection.from;
            return selection;
          };
        },
      });
      return work(proxy);
    }),
  );
  try {
    await cleanupExpiredPromptAttachments(cleanupAt);
  } finally {
    intercepted.mockRestore();
  }
  const [retained] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, id));
  expect(retained.status).toBe('ready');
  expect(objects.has(`${initial.objectPath}/file`)).toBe(true);
});

test('DELETE retains a non-extending tombstone until an ambiguous late write can be swept again', () => inChunkedMode(async () => {
  const handle = await beginPromptAttachment(scope, {
    filename: 'late.txt',
    mime: 'text/plain',
    size: 3,
  });
  deferWrite = true;
  await expect(
    uploadPromptAttachmentChunk(scope, handle.attachment_id, 0, new Uint8Array([1, 2, 3])),
  ).rejects.toThrow('upload failed');
  await deletePromptAttachment(scope, handle.attachment_id);
  const [tombstone] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, handle.attachment_id));
  expect(tombstone?.status).toBe('deleting');
  await deletePromptAttachment(scope, handle.attachment_id);
  const [retry] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, handle.attachment_id));
  expect(retry.expiresAt.getTime()).toBe(tombstone.expiresAt.getTime());
  settleWrite!();
  expect(objects.has(`${tombstone.objectPath}/chunks/0`)).toBe(true);
  await cleanupExpiredPromptAttachments();
  expect(
    await db
      .select()
      .from(promptAttachments)
      .where(eq(promptAttachments.attachmentId, handle.attachment_id)),
  ).toHaveLength(1);
  await expect(completePromptAttachment(scope, handle.attachment_id)).rejects.toMatchObject({
    status: 404,
  });
  await cleanupExpiredPromptAttachments(new Date(tombstone.expiresAt.getTime() + 1));
  expect(objects.has(`${tombstone.objectPath}/chunks/0`)).toBe(false);
  expect(
    await db
      .select()
      .from(promptAttachments)
      .where(eq(promptAttachments.attachmentId, handle.attachment_id)),
  ).toHaveLength(0);
}));

test('mixed handles and uppercase DATA count exactly 100 MiB plus one byte', async () => {
  const ids = [await ready(), await ready()];
  for (const id of ids)
    await db
      .update(promptAttachments)
      .set({ sizeBytes: 50 * 1024 * 1024 })
      .where(eq(promptAttachments.attachmentId, id));
  const parts = ids.map((id) => ({ type: 'file' as const, attachment_id: id }));
  const submit = (
    fileParts: Array<{
      type: 'file';
      attachment_id?: string;
      filename?: string;
      mime?: string;
      url?: string;
    }>,
  ) =>
    enqueueContinueSessionCommand({
      source: 'ui',
      ...scope,
      actorUserId: scope.userId,
      sessionId,
      text: 'boundary',
      clientMessageId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      parts: fileParts,
    });
  expect((await submit(parts)).row.commandId).toBeTruthy();
  await expect(
    submit([
      ...parts,
      { type: 'file', filename: 'one.txt', mime: 'text/plain', url: 'DATA:text/plain;base64,QQ==' },
    ]),
  ).rejects.toMatchObject({ status: 413, code: 'attachment_message_limit' });
});

// Retention (D16) and the begin budget (D17). Loaded as a namespace so a missing
// export fails its own test, not the whole file.
const lifecycle = await import('../projects/prompt-attachments');
const HOUR_MS = 60 * 60_000;
async function settleCommand(
  commandId: string,
  status: 'succeeded' | 'dead_lettered' | 'queued',
  result: Record<string, unknown>,
  updatedAt: Date,
) {
  await db
    .update(sessionLifecycleCommands)
    .set({ status, result, updatedAt })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}
async function referenceCount(id: string) {
  return (
    await db
      .select()
      .from(promptAttachmentReferences)
      .where(eq(promptAttachmentReferences.attachmentId, id))
  ).length;
}
async function attachmentRow(id: string) {
  const [row] = await db
    .select()
    .from(promptAttachments)
    .where(eq(promptAttachments.attachmentId, id));
  return row;
}
const objectKey = (id: string) => `prompt-attachments/${scope.projectId}/${id}/file`;

test('terminal delivery releases references after the grace period; cleanup then removes the object before metadata', async () => {
  const id = await ready();
  const command = await enqueue(id);
  // Inside the grace period: nothing is released.
  await settleCommand(command.row.commandId, 'succeeded', { status: 'delivered' }, new Date(Date.now() - HOUR_MS + 60_000));
  await cleanupExpiredPromptAttachments();
  expect(await referenceCount(id)).toBe(1);
  expect(objects.has(objectKey(id))).toBe(true);

  // Past the grace period: the reference goes, and a failed object removal keeps the metadata.
  await settleCommand(command.row.commandId, 'succeeded', { status: 'delivered' }, new Date(Date.now() - HOUR_MS - 60_000));
  failRemove = true;
  try {
    expect((await cleanupExpiredPromptAttachments()).errors).toBeGreaterThan(0);
  } finally {
    failRemove = false;
  }
  expect(await referenceCount(id)).toBe(0);
  expect(objects.has(objectKey(id))).toBe(true);
  expect(await attachmentRow(id)).toBeDefined();

  await cleanupExpiredPromptAttachments();
  expect(objects.has(objectKey(id))).toBe(false);
  expect(await attachmentRow(id)).toBeUndefined();
});

test('a dead-lettered command keeps its references', async () => {
  const old = new Date(Date.now() - 2 * HOUR_MS);
  const deadLettered = await ready();
  const retryable = await ready();
  const forwarded = await ready();
  await settleCommand((await enqueue(deadLettered)).row.commandId, 'dead_lettered', {}, old);
  await settleCommand((await enqueue(retryable)).row.commandId, 'queued', {}, old);
  // On the wire at OpenCode, not yet consumed by a turn: still undelivered.
  await settleCommand((await enqueue(forwarded)).row.commandId, 'succeeded', { status: 'forwarded' }, old);
  await cleanupExpiredPromptAttachments();
  for (const id of [deadLettered, retryable, forwarded]) {
    expect(await referenceCount(id)).toBe(1);
    expect(objects.has(objectKey(id))).toBe(true);
    expect(await attachmentRow(id)).toBeDefined();
  }
});

test('session delete releases references', async () => {
  const doomed = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO kortix.project_sessions(session_id,account_id,project_id,branch_name,status) VALUES(${doomed},${scope.accountId}::uuid,${scope.projectId}::uuid,${doomed},'running')`,
  );
  const only = await ready();
  const shared = await ready();
  const clientMessageId = crypto.randomUUID();
  await enqueueContinueSessionCommand({
    source: 'ui',
    ...scope,
    actorUserId: scope.userId,
    sessionId: doomed,
    text: 'doomed',
    clientMessageId,
    idempotencyKey: `prompt:${doomed}:${clientMessageId}`,
    parts: [
      { type: 'file', attachment_id: only },
      { type: 'file', attachment_id: shared },
    ],
  });
  // The live session still sends `shared`.
  await enqueue(shared);

  const { deleteSession } = await import('../projects/session-lifecycle/actions');
  expect(
    await deleteSession({
      projectId: scope.projectId,
      sessionId: doomed,
      accountId: scope.accountId,
      userId: scope.userId,
    }),
  ).toEqual({ ok: true });
  expect(await referenceCount(only)).toBe(0);
  expect(await referenceCount(shared)).toBe(1);

  await cleanupExpiredPromptAttachments();
  expect(objects.has(objectKey(only))).toBe(false);
  expect(await attachmentRow(only)).toBeUndefined();
  expect(objects.has(objectKey(shared))).toBe(true);
  expect(await attachmentRow(shared)).toBeDefined();
});

test('project archive releases references', async () => {
  const id = await ready();
  await enqueue(id);
  await lifecycle.releasePromptAttachmentsForProject(scope.projectId);
  expect(await referenceCount(id)).toBe(0);
  await cleanupExpiredPromptAttachments();
  expect(objects.has(objectKey(id))).toBe(false);
  expect(await attachmentRow(id)).toBeUndefined();
});

test('begin budget counts one user\'s live unbound uploads: 40 handles and 500 MiB', async () => {
  const budget = { ...scope, userId: crypto.randomUUID() };
  const begin = (size = 1) =>
    beginPromptAttachment(budget, { filename: 'budget.txt', mime: 'text/plain', size });
  const handles = [];
  for (let index = 0; index < 40; index += 1) handles.push(await begin());
  await expect(begin()).rejects.toMatchObject({ status: 429, code: 'attachment_budget_exceeded' });
  // Another user has an independent budget.
  expect((await beginPromptAttachment(scope, { filename: 'other.txt', mime: 'text/plain', size: 1 })).attachment_id).toBeTruthy();
  // Expired uploads no longer count.
  await db
    .update(promptAttachments)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(promptAttachments.userId, budget.userId));

  const large = [];
  for (let index = 0; index < 10; index += 1) large.push(await begin(50 * 1024 * 1024));
  await expect(begin()).rejects.toMatchObject({ status: 429, code: 'attachment_budget_exceeded' });
  // A bound upload belongs to a sent prompt and no longer counts as unbound.
  const holder = await enqueue(await ready());
  await db
    .insert(promptAttachmentReferences)
    .values({ commandId: holder.row.commandId, attachmentId: large[0]!.attachment_id });
  expect((await begin()).attachment_id).toBeTruthy();
});
