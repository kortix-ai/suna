import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  AdapterCapabilitiesSchema,
  CapabilityFeaturesSchema,
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
  KNOWN_TOOL_KINDS,
  type AdapterCapabilities,
  type CapabilityFeatures,
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
const _capsFitSchema: z.input<typeof AdapterCapabilitiesSchema> = {} as AdapterCapabilities;
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
  SameKeys<z.output<typeof AdapterCapabilitiesSchema>, AdapterCapabilities>,
  SameKeys<z.output<typeof CapabilityFeaturesSchema>, CapabilityFeatures>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true];
void _typesFitSchemas;
void _capsFitSchema;
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
  id: 'b0',
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

  test('golden.v2.json keeps v 0 (a 2.0 record, plus the required minor 1 fields id and restore_grade) and validates', () => {
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

// ─── Freeze additions F1–F12 (minor 1) ───────────────────────────────────────

const text = (id: string, patch: Partial<TextBlock> = {}): TextBlock => ({ type: 'text', id, text: 'hi', ...patch });
const accepts = (message: SessionLogMessage) => SessionLogMessageSchema.safeParse(message).success;
const withSession = (patch: Record<string, unknown>) => ({ ...clone(load('golden21.v2.json')), ...patch });
const features = {
  tool_error_channel: false,
  attachments: { user: ['image/png'], tool_result: true },
  compaction: ['summary_first_tail' as const],
  subagents: 'sync' as const,
  todos: false,
  reasoning_replay: 'lowers_to_text' as const,
  freeform_tool_input: false,
};

describe('F1/F2 block id', () => {
  test('every block type requires a non-empty id', () => {
    const blocks: SessionLogMessage['blocks'] = [
      text('p1'),
      { type: 'reasoning', id: 'p2', text: 'r' },
      { type: 'attachment', id: 'p3', ref: 'obj:1', mime: 'image/png', bytes: 1 },
      call({ id: 'p4', result: { content: [], is_error: false } }),
      { type: 'compaction', id: 'p5', summary: null, first_kept_message_id: null },
      { type: 'subtask', id: 'p6', thread_id: 't2', agent: 'a', description: 'd' },
      { type: 'step', id: 'p7', phase: 'start' },
      { type: 'harness', id: 'p8', harness: 'codex', kind: 'k', data: null, model_visible: false },
    ];
    expect(accepts(assistant(blocks))).toBe(true);
    blocks.forEach((block, i) => {
      const noId = clone(blocks);
      delete (noId[i] as Partial<typeof block>).id;
      expect(accepts(assistant(noId))).toBe(false);
      expect(accepts(assistant(blocks.map((b, j) => (j === i ? { ...b, id: '' } : b))))).toBe(false);
    });
  });

  test('a repeated id in one message is rejected; the same id in two messages is accepted', () => {
    const issue = firstIssue(SessionLogMessageSchema.safeParse(assistant([text('x'), text('x')])));
    expect(issue.path).toEqual(['blocks', 1, 'id']);
    expect(accepts(assistant([text('x')]))).toBe(true);
    expect(accepts({ ...assistant([text('x')]), message_id: 'm2' })).toBe(true);
  });
});

describe('F3 large text by reference', () => {
  test('a preview with ref and bytes is accepted; a wrong type is rejected', () => {
    expect(accepts(assistant([text('a', { text: 'x'.repeat(16_384), ref: 'blob:abc', bytes: 300_000 })]))).toBe(true);
    expect(accepts(assistant([text('a', { ref: 7 as never })]))).toBe(false);
    expect(accepts(assistant([text('a', { bytes: '300000' as never })]))).toBe(false);
    expect(accepts(assistant([text('a', { bytes: -1 })]))).toBe(false);
  });
});

describe('F4 restore grade', () => {
  test('requires restore_grade, one of three values', () => {
    for (const grade of ['native', 'converted', 'partial']) expect(SessionLogSchema.safeParse(withSession({ restore_grade: grade })).success).toBe(true);
    expect(SessionLogSchema.safeParse(withSession({ restore_grade: 'lossy' })).success).toBe(false);
    const record: Record<string, unknown> = withSession({});
    delete record.restore_grade;
    expect(firstIssue(SessionLogSchema.safeParse(record)).path).toEqual(['restore_grade']);
  });

  test('grade_counts is optional and holds three counts', () => {
    const counts = { tool_input: 2, cut_point: 1, attachment: 0 };
    expect(SessionLogSchema.safeParse(withSession({ restore_grade: 'partial', grade_counts: counts })).success).toBe(true);
    expect(SessionLogSchema.safeParse(withSession({ grade_counts: { tool_input: 2, cut_point: 1 } })).success).toBe(false);
    expect(SessionLogSchema.safeParse(withSession({ grade_counts: { ...counts, attachment: -1 } })).success).toBe(false);
  });
});

describe('F5 attachment sha256', () => {
  const attachment = (patch: Record<string, unknown>) => assistant([{ type: 'attachment', id: 'a', ref: 'obj:old', mime: 'image/png', bytes: 1, ...patch } as never]);
  test('is optional; a present value must be a string', () => {
    expect(accepts(attachment({}))).toBe(true);
    expect(accepts(attachment({ sha256: 'ab'.repeat(32) }))).toBe(true);
    expect(accepts(attachment({ sha256: 5 }))).toBe(false);
  });
});

describe('F6 producer kortix-v1-import', () => {
  test('a converted row names its producer', () => {
    const converted = { ...assistant([text('a')]), producer: { harness: 'kortix-v1-import', harness_version: '1', adapter_version: '1' } };
    expect(accepts(converted)).toBe(true);
    expect(accepts({ ...converted, producer: { harness: 'kortix-v1-import' } as never })).toBe(false);
  });
});

describe('pass-through strings are non-empty', () => {
  const empty = (msg: SessionLogMessage) => accepts(msg);
  test('Producer.harness, ModelRef.api, HarnessBlock kind and harness, and both error codes reject ""', () => {
    const base = assistant([text('a')]);
    expect(empty({ ...base, producer: { ...base.producer, harness: '' } })).toBe(false);
    expect(empty({ ...base, model: { provider: 'p', model: 'm', api: '' } })).toBe(false);
    expect(empty({ ...base, error: { code: '', message: 'm' } })).toBe(false);
    const harness = { type: 'harness' as const, id: 'h', harness: 'codex', kind: 'k', data: null, model_visible: false };
    expect(empty(assistant([harness]))).toBe(true);
    expect(empty(assistant([{ ...harness, kind: '' }]))).toBe(false);
    expect(empty(assistant([{ ...harness, harness: '' }]))).toBe(false);
    const result = { content: [], is_error: true, error: { code: '', message: 'm' } };
    expect(empty(assistant([call({ status: 'error', result })]))).toBe(false);
  });
});

describe('byte counts', () => {
  test('attachment bytes must be a non-negative integer', () => {
    const att = (bytes: number) => assistant([{ type: 'attachment', id: 'a', ref: 'o', mime: 'image/png', bytes }]);
    expect(accepts(att(0))).toBe(true);
    expect(accepts(att(-1))).toBe(false);
    expect(accepts(att(1.5))).toBe(false);
  });
});

describe('F7 layout text entry', () => {
  test('the { text } entry carries the OpenCode v2 recent-context; { context } is not a layout entry', () => {
    const layout = (entry: unknown) => assistant([{ type: 'compaction', id: 'c', summary: 's', first_kept_message_id: null, layout: [{ summary: true }, entry] } as never]);
    expect(accepts(layout({ text: '[User]: kept' }))).toBe(true);
    expect(accepts(layout({ context: '[User]: kept' }))).toBe(false);
  });
});

describe('F8 native_agent_id', () => {
  test('is an optional string on thread and message', () => {
    expect(accepts({ ...assistant([text('a')]), agent: 'build', native_agent_id: 'general-purpose' })).toBe(true);
    expect(accepts({ ...assistant([text('a')]), native_agent_id: 3 as never })).toBe(false);
    const record = withSession({});
    record.threads[0] = { ...record.threads[0], agent: 'build', native_agent_id: 'general-purpose' };
    expect(SessionLogSchema.safeParse(record).success).toBe(true);
    record.threads[0] = { ...record.threads[0], native_agent_id: 3 as never };
    expect(firstIssue(SessionLogSchema.safeParse(record)).path).toEqual(['threads', 0, 'native_agent_id']);
  });
});

describe('F9 capabilities split', () => {
  const caps: AdapterCapabilities = {
    harness: 'opencode-v2',
    harness_versions: '>=1.18.23',
    schema_minors: [0, 1],
    dialects: ['openai-chat'],
    native: { ...features, compaction: ['summary_first_tail', 'text_tail'] },
    rendered: { ...features, compaction: ['summary_first_tail', 'text_tail', 'layout'], freeform_tool_input: true },
  };
  test('native and rendered are both required', () => {
    expect(AdapterCapabilitiesSchema.safeParse(caps).success).toBe(true);
    const { native, ...noNative } = caps;
    void native;
    expect(firstIssue(AdapterCapabilitiesSchema.safeParse(noNative)).path).toEqual(['native']);
    const { rendered, ...noRendered } = caps;
    void rendered;
    expect(firstIssue(AdapterCapabilitiesSchema.safeParse(noRendered)).path).toEqual(['rendered']);
  });
  test('the old flat feature fields no longer satisfy the schema', () => {
    expect(AdapterCapabilitiesSchema.safeParse({ harness: 'x', harness_versions: '1', schema_minors: [1], dialects: [], ...features }).success).toBe(false);
  });
  test('an unknown compaction mode is rejected', () => {
    expect(AdapterCapabilitiesSchema.safeParse({ ...caps, native: { ...features, compaction: ['magic'] } }).success).toBe(false);
  });
});

describe('F10 orphan tool result', () => {
  test('is kept as a harness block of kind orphan_output (no dedicated field)', () => {
    const orphan = { type: 'harness' as const, id: 'o', harness: 'codex', kind: 'orphan_output', data: { call_id: 'gone', output: 'ok' }, model_visible: false, fallback_text: 'ok' };
    expect(accepts(assistant([orphan]))).toBe(true);
  });
});

describe('F11 interrupted error code', () => {
  test('a call closed with error code interrupted is accepted', () => {
    const result = { content: [{ type: 'text' as const, text: '[interrupted]' }], is_error: true, synthetic: true, error: { code: 'interrupted', message: 'the box stopped' } };
    expect(accepts(assistant([call({ status: 'error', result })], 'interrupted'))).toBe(true);
  });
  test('any other code string still validates', () => {
    expect(accepts({ ...assistant([text('a')], 'error'), error: { code: 'rate_limit', message: 'slow down' } })).toBe(true);
  });
});

describe('F12 tool kind passthrough', () => {
  test('KNOWN_TOOL_KINDS lists the 16 known kinds', () => {
    expect(KNOWN_TOOL_KINDS.length).toBe(16);
    expect(KNOWN_TOOL_KINDS).toContain('shell');
    expect(KNOWN_TOOL_KINDS).toContain('other');
  });
  test('known and harness-defined kinds are accepted; an empty or non-string kind is rejected', () => {
    for (const kind of ['shell', 'other', 'screenshot', 'x-vendor.fetch']) {
      expect(accepts(assistant([call({ kind, result: { content: [], is_error: false } })]))).toBe(true);
    }
    for (const kind of ['', 7]) {
      expect(accepts(assistant([call({ kind: kind as never, result: { content: [], is_error: false } })]))).toBe(false);
    }
  });
});
