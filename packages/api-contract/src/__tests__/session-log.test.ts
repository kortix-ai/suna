import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  AttachmentBlockSchema,
  CompactionBlockSchema,
  HarnessBlockSchema,
  ReasoningBlockSchema,
  SessionLogMessageSchema,
  SessionLogSchema,
  StepBlockSchema,
  SubtaskBlockSchema,
  TextBlockSchema,
  SessionLogThreadSchema,
  ToolCallBlockSchema,
  upcast,
  type AttachmentBlock,
  type CompactionBlock,
  type HarnessBlock,
  type ReasoningBlock,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogThread,
  type StepBlock,
  type SubtaskBlock,
  type TextBlock,
  type ToolCallBlock,
} from '../session-log';

const FIXTURES = join(import.meta.dir, 'fixtures', 'session-log');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as SessionLog;
const clone = <T>(value: T): T => structuredClone(value);

// Compile-time drift check between types.ts and schema.ts. A record typed as the
// hand-written type must fit the validator's input (types and required fields), and
// both must list the same keys (the validator output makes a `unknown` field optional,
// so output-to-type assignability is not usable).
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
const _typesFitSchemas: z.input<typeof SessionLogSchema> = {} as SessionLog;
const _sameKeys: [
  SameKeys<z.output<typeof SessionLogSchema>, SessionLog>,
  SameKeys<z.output<typeof SessionLogThreadSchema>, SessionLogThread>,
  SameKeys<z.output<typeof SessionLogMessageSchema>, SessionLogMessage>,
  SameKeys<z.output<typeof TextBlockSchema>, TextBlock>,
  SameKeys<z.output<typeof ReasoningBlockSchema>, ReasoningBlock>,
  SameKeys<z.output<typeof AttachmentBlockSchema>, AttachmentBlock>,
  SameKeys<z.output<typeof ToolCallBlockSchema>, ToolCallBlock>,
  SameKeys<z.output<typeof CompactionBlockSchema>, CompactionBlock>,
  SameKeys<z.output<typeof SubtaskBlockSchema>, SubtaskBlock>,
  SameKeys<z.output<typeof StepBlockSchema>, StepBlock>,
  SameKeys<z.output<typeof HarnessBlockSchema>, HarnessBlock>,
] = [true, true, true, true, true, true, true, true, true, true, true];
void _typesFitSchemas;
void _sameKeys;

const EXPORTS = ['pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'].map((h) => `${h}.v2.json`);
const GOLDEN = ['golden.v2.json', 'golden21.v2.json'];

const assistant = (blocks: SessionLogMessage['blocks'], status: SessionLogMessage['status'] = 'complete'): SessionLogMessage => ({
  schema: SESSION_LOG_SCHEMA,
  v: SESSION_LOG_MINOR,
  message_id: 'm1',
  thread_id: 't1',
  seq: 1,
  role: 'assistant',
  kind: 'turn',
  status,
  in_context: true,
  model: null,
  usage: null,
  finish: null,
  error: null,
  created_at: '2026-01-01T00:00:00.000Z',
  completed_at: null,
  producer: { harness: 'test', harness_version: '0', adapter_version: '0' },
  blocks,
});
const call = (patch: Partial<ToolCallBlock>): ToolCallBlock => ({
  type: 'tool_call',
  call_id: 'c1',
  name: 'bash',
  kind: 'shell',
  input: {},
  status: 'complete',
  ...patch,
});

describe('session-log constants', () => {
  test('schema id and minor', () => {
    expect(SESSION_LOG_SCHEMA).toBe('kortix.session/2');
    expect(SESSION_LOG_MINOR).toBe(1);
  });
});

describe('session-log accepts the harness exports and golden sessions', () => {
  for (const name of [...EXPORTS, ...GOLDEN]) {
    test(name, () => {
      const record = load(name);
      expect(SessionLogSchema.safeParse(record).success).toBe(true);
      expect(upcast(record)).toBe(record);
    });
  }

  test('golden.v2.json is a 2.0 record (v 0): a minor 1 reader still reads it', () => {
    expect(load('golden.v2.json').v).toBe(0);
  });
});

const firstIssue = (result: { success: boolean; error?: z.ZodError }) => {
  expect(result.success).toBe(false);
  return result.error!.issues[0];
};

describe('session-log rejects', () => {
  test('a session with no v', () => {
    const record: Record<string, unknown> = clone(load('golden21.v2.json'));
    delete record.v;
    expect(firstIssue(SessionLogSchema.safeParse(record)).path).toEqual(['v']);
    expect(() => upcast(record)).toThrow();
  });

  test('a thread or message with no v', () => {
    const noThreadV = clone(load('golden21.v2.json'));
    delete (noThreadV.threads[0] as Record<string, unknown>).v;
    expect(firstIssue(SessionLogSchema.safeParse(noThreadV)).path).toEqual(['threads', 0, 'v']);

    const noMessageV = clone(load('golden21.v2.json'));
    delete (noMessageV.threads[0].messages[0] as Record<string, unknown>).v;
    expect(firstIssue(SessionLogSchema.safeParse(noMessageV)).path).toEqual(['threads', 0, 'messages', 0, 'v']);
  });

  test('another schema id', () => {
    const issue = firstIssue(SessionLogSchema.safeParse({ ...load('golden21.v2.json'), schema: 'kortix.session/3' }));
    expect(issue.path).toEqual(['schema']);
    expect(issue.code).toBe('invalid_literal');
  });

  test('an unknown block type', () => {
    const record = clone(load('golden21.v2.json'));
    const blocks = record.threads[0].messages[0].blocks;
    blocks.push({ type: 'hologram' } as never);
    const issue = firstIssue(SessionLogSchema.safeParse(record));
    expect(issue.path).toEqual(['threads', 0, 'messages', 0, 'blocks', blocks.length - 1, 'type']);
    expect(issue.code).toBe('invalid_union_discriminator');
    expect(() => upcast(record)).toThrow();
  });
});

describe('session-log closure rule', () => {
  const closed = { content: [{ type: 'text' as const, text: '[interrupted]' }], is_error: true, synthetic: true };
  const open = (patch: Partial<SessionLogMessage>, blocks = [call({})]) => ({ ...assistant(blocks), ...patch });

  test('an in-context message at rest with a tool call and no result is rejected', () => {
    for (const status of ['complete', 'error', 'aborted', 'interrupted'] as const) {
      const issue = firstIssue(SessionLogMessageSchema.safeParse(assistant([call({})], status)));
      expect(issue.path).toEqual(['blocks', 0]);
      expect(issue.code).toBe('custom');
    }
  });

  test('an in-context message at rest with a pending or running tool call is rejected, even with a result', () => {
    const result = { content: [], is_error: false };
    for (const status of ['pending', 'running'] as const) {
      expect(firstIssue(SessionLogMessageSchema.safeParse(assistant([call({ status, result })]))).path).toEqual(['blocks', 0]);
    }
  });

  test('an out-of-context message may keep an open tool call (a hidden aborted reply)', () => {
    const hidden = { in_context: false, hidden_reason: 'aborted' as const, status: 'aborted' as const };
    const openCall = [call({ status: 'error' })];
    expect(SessionLogMessageSchema.safeParse(open(hidden, openCall)).success).toBe(true);
    expect(SessionLogMessageSchema.safeParse(open({ ...hidden, in_context: true }, openCall)).success).toBe(false);
  });

  test('an interrupted call closed with is_error and synthetic is accepted', () => {
    expect(SessionLogMessageSchema.safeParse(assistant([call({ status: 'error', result: closed })], 'interrupted')).success).toBe(true);
  });

  test('a streaming message may hold an open tool call', () => {
    expect(SessionLogMessageSchema.safeParse(assistant([call({ status: 'running' })], 'streaming')).success).toBe(true);
  });
});

describe('upcast', () => {
  test('returns the input unchanged, keeping fields this reader does not know', () => {
    const record = { ...clone(load('golden21.v2.json')), added_in_a_later_minor: { a: 1 } };
    const out = upcast(record);
    expect(out).toBe(record as unknown as SessionLog);
    expect((out as unknown as Record<string, unknown>).added_in_a_later_minor).toEqual({ a: 1 });
  });

  test('reads a record from a later minor', () => {
    expect(upcast({ ...load('golden21.v2.json'), v: SESSION_LOG_MINOR + 1 }).v).toBe(SESSION_LOG_MINOR + 1);
  });
});
