import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  SessionLogMessageSchema,
  SessionLogSchema,
  SessionLogThreadSchema,
  ToolCallBlockSchema,
  upcast,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogThread,
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
  SameKeys<z.output<typeof ToolCallBlockSchema>, ToolCallBlock>,
] = [true, true, true, true];
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

describe('session-log rejects', () => {
  test('a session with no v', () => {
    const record: Record<string, unknown> = clone(load('golden21.v2.json'));
    delete record.v;
    expect(() => upcast(record)).toThrow();
  });

  test('a thread or message with no v', () => {
    const noThreadV = clone(load('golden21.v2.json'));
    delete (noThreadV.threads[0] as Record<string, unknown>).v;
    expect(SessionLogSchema.safeParse(noThreadV).success).toBe(false);

    const noMessageV = clone(load('golden21.v2.json'));
    delete (noMessageV.threads[0].messages[0] as Record<string, unknown>).v;
    expect(SessionLogSchema.safeParse(noMessageV).success).toBe(false);
  });

  test('another schema id', () => {
    expect(() => upcast({ ...load('golden21.v2.json'), schema: 'kortix.session/3' })).toThrow();
  });

  test('an unknown block type', () => {
    const record = clone(load('golden21.v2.json'));
    record.threads[0].messages[0].blocks.push({ type: 'hologram' } as never);
    expect(() => upcast(record)).toThrow();
  });
});

describe('session-log closure rule', () => {
  const closed = { content: [{ type: 'text' as const, text: '[interrupted]' }], is_error: true, synthetic: true };

  test('a message at rest with a tool call and no result is rejected', () => {
    for (const status of ['complete', 'error', 'aborted', 'interrupted'] as const) {
      expect(SessionLogMessageSchema.safeParse(assistant([call({})], status)).success).toBe(false);
    }
  });

  test('a message at rest with a pending or running tool call is rejected, even with a result', () => {
    const result = { content: [], is_error: false };
    expect(SessionLogMessageSchema.safeParse(assistant([call({ status: 'pending', result })])).success).toBe(false);
    expect(SessionLogMessageSchema.safeParse(assistant([call({ status: 'running', result })])).success).toBe(false);
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
