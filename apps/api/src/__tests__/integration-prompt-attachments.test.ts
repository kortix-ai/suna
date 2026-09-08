import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  promptAttachments,
  promptAttachmentReferences,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  beginPromptAttachment,
  bindPromptAttachments,
  cleanupExpiredPromptAttachments,
  completePromptAttachment,
  resolvePromptAttachment,
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
const objects = new Map<string, Uint8Array>();
const originalFetch = globalThis.fetch;
let failWrite = false;
let failRemove = false;
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
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = decodeURIComponent(new URL(request.url).pathname).replace(
        /^\/storage\/v1\/object\/(?:authenticated\/|sign\/)?staged-files\/?/,
        '',
      );
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
        objects.set(path, new Uint8Array(await request.arrayBuffer()));
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
  await uploadPromptAttachmentChunk(scope, handle.attachment_id, 0, new Uint8Array([1, 2, 3]));
  await completePromptAttachment(scope, handle.attachment_id);
  return handle.attachment_id;
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

test('ambiguous chunk and final-object writes retry idempotently with tracked object names', async () => {
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
});

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
  const resolved = await resolvePromptAttachment({
    attachmentId: id,
    commandId: first.row.commandId,
    ...scope,
    sessionId,
  });
  expect(await resolved.readBytes()).toEqual(new Uint8Array([1, 2, 3]));
  await expect(
    resolvePromptAttachment({
      attachmentId: id,
      commandId: first.row.commandId,
      ...scope,
      sessionId: crypto.randomUUID(),
    }),
  ).rejects.toThrow('unavailable');
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
