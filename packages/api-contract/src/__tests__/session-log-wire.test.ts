import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SessionLogJournalConflictSchema,
  SessionLogJournalRequestSchema,
  SessionLogJournalResponseSchema,
  SessionLogManifestSchema,
  type SessionLog,
  type SessionLogJournalRequest,
} from '../session-log';

const golden = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'session-log', 'golden.v2.json'), 'utf8')) as SessionLog;

/** A journal batch built from the golden record: every message as a put, every thread as an upsert. */
function batch(): SessionLogJournalRequest {
  const { threads, ...session } = structuredClone(golden);
  return {
    generation: 3,
    puts: threads.flatMap((t) => t.messages.map((message) => ({ rev: 1, message }))),
    tombstones: [{ message_id: 'msg_gone', rev: 2 }],
    threads: threads.map(({ messages: _, ...thread }) => thread),
    session,
  };
}

describe('session-log journal wire', () => {
  test('a batch of the golden record validates, with and without the session patch', () => {
    const body = batch();
    expect(body.puts.length).toBeGreaterThan(10);
    expect(SessionLogJournalRequestSchema.parse(body).puts.length).toBe(body.puts.length);
    const { session: _, ...noPatch } = body;
    expect(SessionLogJournalRequestSchema.safeParse(noPatch).success).toBe(true);
    // A patch may name one field only.
    expect(SessionLogJournalRequestSchema.safeParse({ ...noPatch, session: { title: 'renamed' } }).success).toBe(true);
  });

  test('a put validates its message: an open in-context tool call at rest is rejected', () => {
    const body = batch();
    const put = body.puts.find((p) => p.message.status === 'complete' && p.message.in_context && p.message.blocks.some((b) => b.type === 'tool_call'));
    if (!put) throw new Error('golden has a completed in-context message with a tool call');
    const call = put.message.blocks.find((b) => b.type === 'tool_call');
    if (!call || call.type !== 'tool_call') throw new Error('unreachable');
    call.status = 'running';
    delete call.result;
    expect(SessionLogJournalRequestSchema.safeParse(body).success).toBe(false);
  });

  test('generation and rev are non-negative integers; a missing generation is rejected', () => {
    const body = batch();
    expect(SessionLogJournalRequestSchema.safeParse({ ...body, generation: -1 }).success).toBe(false);
    expect(SessionLogJournalRequestSchema.safeParse({ ...body, generation: 1.5 }).success).toBe(false);
    const { generation: _, ...noGeneration } = body;
    expect(SessionLogJournalRequestSchema.safeParse(noGeneration).success).toBe(false);
    expect(SessionLogJournalRequestSchema.safeParse({ ...body, tombstones: [{ message_id: 'm', rev: -1 }] }).success).toBe(false);
    expect(SessionLogJournalRequestSchema.safeParse({ ...body, puts: [{ rev: 1, message: { message_id: 'm' } }] }).success).toBe(false);
  });

  test('a thread upsert carries no messages: a thread with messages keeps them out of the parsed body', () => {
    const body = batch();
    const parsed = SessionLogJournalRequestSchema.parse({ ...body, threads: [{ ...body.threads[0], messages: [] }] });
    expect('messages' in parsed.threads[0]!).toBe(false);
  });

  test('the 200, 409 and manifest answers', () => {
    expect(SessionLogJournalResponseSchema.parse({ acked: [{ message_id: 'm1', rev: 2 }] }).acked).toEqual([{ message_id: 'm1', rev: 2 }]);
    expect(SessionLogJournalResponseSchema.safeParse({ acked: [{ message_id: '', rev: 2 }] }).success).toBe(false);
    expect(SessionLogJournalConflictSchema.parse({ generation: 4 }).generation).toBe(4);
    expect(SessionLogManifestSchema.parse({ messages: [{ message_id: 'm1', content_hash: 'sha256:ab' }] }).messages).toHaveLength(1);
    expect(SessionLogManifestSchema.safeParse({ messages: [{ message_id: 'm1' }] }).success).toBe(false);
  });
});
